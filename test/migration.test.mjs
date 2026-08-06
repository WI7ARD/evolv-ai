import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase, runMigrations } from "../lib/database.mjs";
import { PROFILE_MIGRATIONS } from "../lib/schema.mjs";
import { createAccountStore } from "../lib/accounts.mjs";
import { createProfileManager } from "../lib/profiles.mjs";

// A representative single-user credential. The values do not need to verify
// against a password here — the migration only has to carry them intact into
// the owner profile so the original login keeps working after the upgrade.
function legacyCredential() {
  return {
    passwordHash: crypto.randomBytes(64).toString("base64"),
    passwordSalt: crypto.randomBytes(24).toString("base64"),
    scryptN: 1024,
    scryptR: 8,
    scryptP: 1,
    keyLength: 64,
    recoveryHash: crypto.createHash("sha256").update("recovery").digest("base64")
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-migrate-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyDbPath = path.join(dataDir, "evolv.db");

  // Seed the pre-multi-account database: a single login plus real chat history.
  const legacy = createDatabase({ dataDir, dbPath: legacyDbPath, defaultPrompt: "Legacy prompt" });
  legacy.createAuthCredential(legacyCredential());
  const conversation = legacy.createConversation({ title: "Before profiles" });
  legacy.addMessage({ conversationId: conversation.id, role: "user", content: "Remember this" });
  legacy.addMessage({ conversationId: conversation.id, role: "assistant", content: "I will", model: "legacy-model" });
  legacy.close();

  return { root, dataDir, legacyDbPath, conversationId: conversation.id };
}

test("the single-user login migrates into an owner profile on first launch", async (t) => {
  const { root, dataDir, legacyDbPath } = await fixture();
  const legacyDatabase = createDatabase({ dataDir, dbPath: legacyDbPath, defaultPrompt: "Legacy prompt" });
  const accounts = createAccountStore({ dataDir, legacyDatabase, legacyDbPath });
  t.after(async () => {
    legacyDatabase.close();
    accounts.close();
    await rm(root, { recursive: true, force: true });
  });

  // Exactly one auto-created account named "owner", carrying the legacy hashes.
  assert.equal(accounts.countUsers(), 1);
  const owner = accounts.getOnlyUser();
  assert.equal(owner.username, "owner");
  assert.equal(owner.passwordHash, legacyDatabase.getAuthCredential().passwordHash);
  assert.equal(accounts.getMeta("legacy_claimed_by"), owner.id);
  assert.equal(accounts.getMeta("legacy_source"), legacyDbPath);

  const audits = accounts.raw.prepare("SELECT event_type FROM account_audit").all();
  assert.ok(audits.some((row) => row.event_type === "account.migrated"));
});

test("the owner profile inherits the legacy conversations and backs up the source", async (t) => {
  const { root, dataDir, legacyDbPath, conversationId } = await fixture();
  const legacyDatabase = createDatabase({ dataDir, dbPath: legacyDbPath, defaultPrompt: "Legacy prompt" });
  const accounts = createAccountStore({ dataDir, legacyDatabase, legacyDbPath });
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const profiles = createProfileManager({
    dataDir,
    accounts,
    legacyStateFile: path.join(dataDir, "state.json"),
    defaultPrompt: "Legacy prompt",
    workspaceRoot,
    retrieveKnowledge: async () => [],
    secretStore: { available: false, description: "test", encrypt: async (v) => v, decrypt: async (v) => v },
    ollamaUrl: "http://127.0.0.1:11434"
  });
  const owner = accounts.getOnlyUser();
  t.after(async () => {
    profiles.close();
    legacyDatabase.close();
    accounts.close();
    await rm(root, { recursive: true, force: true });
  });

  const context = await profiles.get(owner.id);
  // The legacy chat history is now readable inside the isolated owner profile.
  const migrated = context.database.getConversation(conversationId);
  assert.equal(migrated.title, "Before profiles");
  assert.equal(migrated.messages.length, 2);
  assert.equal(migrated.messages[0].content, "Remember this");

  // A pre-profiles safety copy of the source database was written to backups/.
  const backups = await readdir(path.join(dataDir, "backups"));
  assert.ok(backups.some((name) => name.startsWith("pre-profiles-evolv-") && name.endsWith(".db")));
  assert.equal(accounts.getMeta("legacy_profile_copied") != null, true);

  // The owner's profile database lives under its own per-user directory.
  assert.ok(fs.existsSync(path.join(profiles.profilesDir, owner.id, "evolv.db")));
});

test("the migration ledger records every applied migration in order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-ledger-"));
  const dataDir = path.join(root, "data");
  const database = createDatabase({ dataDir, defaultPrompt: "Ledger" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  const ledger = database.raw.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(ledger.map((row) => row.version), PROFILE_MIGRATIONS.map((item) => item.version));
  assert.deepEqual(ledger.map((row) => row.name), PROFILE_MIGRATIONS.map((item) => item.name));
  for (const row of ledger) assert.equal(row.checksum.length, 64, `migration ${row.version} recorded no checksum`);

  // Feature tables exist because the schema is applied, not because some
  // service happened to be constructed first.
  for (const table of ["engineering_actions", "marketplace_installed", "vault_notes", "tool_recipe_proposals"]) {
    assert.ok(database.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} is missing`);
  }

  // Re-running is a no-op rather than a replay.
  assert.deepEqual(runMigrations(database.raw).map((item) => item.status), PROFILE_MIGRATIONS.map(() => "already-applied"));
});

test("a database written before the ledger adopts the baseline instead of replaying it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-preledger-"));
  const dataDir = path.join(root, "data");
  let database = createDatabase({ dataDir, defaultPrompt: "Ledger" });
  const conversation = database.createConversation({ title: "Before the ledger" });
  database.addMessage({ conversationId: conversation.id, role: "user", content: "survive the upgrade" });
  // Reproduce the pre-ledger row exactly: the baseline version, no checksum,
  // and nothing recorded above it.
  database.raw.exec("DELETE FROM schema_migrations WHERE version > 10");
  database.raw.prepare("UPDATE schema_migrations SET name='', checksum='' WHERE version = 10").run();
  database.close();

  database = createDatabase({ dataDir, defaultPrompt: "Ledger" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const ledger = database.raw.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(ledger.map((row) => row.version), PROFILE_MIGRATIONS.map((item) => item.version));
  assert.equal(ledger[0].name, "core-schema");
  assert.equal(ledger[0].checksum.length, 64, "the adopted baseline must gain a checksum");
  assert.equal(database.getConversation(conversation.id).messages[0].content, "survive the upgrade");
});

test("editing an applied migration is refused rather than silently diverging", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-tamper-"));
  const dataDir = path.join(root, "data");
  const database = createDatabase({ dataDir, defaultPrompt: "Ledger" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const edited = PROFILE_MIGRATIONS.map((item) => (item.version === 11
    ? { ...item, sql: `${item.sql}\nCREATE TABLE IF NOT EXISTS sneaked_in (id TEXT PRIMARY KEY);` }
    : item));
  assert.throws(() => runMigrations(database.raw, edited), (error) => error.code === "MIGRATION_CHECKSUM_MISMATCH");
  assert.equal(database.raw.prepare("SELECT 1 FROM sqlite_master WHERE name='sneaked_in'").get(), undefined);
});
