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

// A migration that has shipped is history, and history does not change.
//
// The circuits table was once appended to the end of the physics-scenes
// migration instead of being added as its own. That rewrote the recorded SQL of
// a migration every existing database had already run, so the checksum guard —
// working exactly as designed — refused to open every profile created before
// the edit. A person with months of conversations got an opaque 500 and a
// working empty account, which reads as "my data is gone".
//
// Nothing caught it: the guard fires on a user's disk, not in CI, because CI
// only ever builds fresh databases where no ledger row exists yet to disagree.
// This is the test that would have. Editing the SQL of any shipped migration
// now fails here, in seconds, with the version named.
test("every shipped migration keeps the checksum it shipped with", async () => {
  const { PROFILE_MIGRATIONS } = await import("../lib/schema.mjs");
  const { createHash } = await import("node:crypto");

  // Add a line for a new migration; never edit an existing one. If a change to
  // released schema is genuinely unavoidable, the old checksum belongs in
  // SUPERSEDED_CHECKSUMS in lib/database.mjs so existing profiles still open.
  const shipped = [
    [10, "core-schema", "f38a3d085820ba732a46471459e862ea332e786e095dde1462f25164dc849d8e"],
    [11, "engineering-actions", "4ef832af22a436daf73bba0c94bbbd1baa6e904957b4b18871a85d2573f44f0f"],
    [12, "marketplace", "05c06ad8ba455829cf8d5fb24d07f51691ad52942dc8f2717dd8d860be848df3"],
    [13, "obsidian-vault", "1f047c855997f05a9eaf8e52c2e7742104a94a0cf714a8343267635b270e92fe"],
    [14, "tool-recipes", "63f65f0e6a9127fd459d05fb5cc03e0a0a78108a7707d6020bf6966ffaaabf3c"],
    [15, "sandbox", "26f2eb85bad976b19ce242fb4543e7d00b4cce1479d530fed47ec67f336c64f0"],
    [16, "physics-scenes", "cdf33ed6d8d0bc2b74aa0fd2d7602ff9d4c60c59ddc0f62eee7324c538af344f"],
    [17, "model-health", "351ce56abe1a819577b8a18e5f2f097991a38512e39d7cbca59b55937165bb0a"],
    [18, "circuits", "5c4646d3e0948b89c3c45e4a446d553d4fed2e25cf4a0167195a7969400279bd"]
  ];

  for (const [version, name, checksum] of shipped) {
    const migration = PROFILE_MIGRATIONS.find((entry) => entry.version === version);
    assert.ok(migration, `migration ${version} (${name}) has been removed; shipped migrations cannot be deleted`);
    assert.equal(migration.name, name, `migration ${version} was renamed`);
    assert.equal(
      createHash("sha256").update(migration.sql).digest("hex"), checksum,
      `migration ${version} (${name}) was edited after it shipped — every existing profile would refuse to open. Add a new migration instead.`
    );
  }
  // New migrations are welcome; they just have to be pinned here too.
  const unpinned = PROFILE_MIGRATIONS.filter((entry) => !shipped.some(([version]) => version === entry.version));
  assert.deepEqual(unpinned.map((entry) => entry.version), [], "a new migration needs a line in the table above");
});

test("a profile written while the circuits edit was live is healed, not refused", async (t) => {
  // The mirror image of the same fault. Splitting circuits back out restores
  // migration 16's original text, which unlocks every profile made before the
  // edit — but profiles made *during* it recorded the altered checksum and
  // would now be refused instead. Both populations exist in the wild, so the
  // ledger has to know this one version legitimately had two texts.
  const root = await mkdtemp(path.join(tmpdir(), "evolv-healed-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const database = createDatabase({ dataDir: root, dbPath: path.join(root, "p.db"), defaultPrompt: "test" });
  t.after(() => database.close());

  database.raw.prepare("INSERT INTO conversations(id,title,created_at,updated_at) VALUES (?,?,?,?)")
    .run("c1", "months of conversations", "now", "now");
  // Stamp version 16 exactly as the shipped-broken build would have.
  const altered = "e59a098990f7ed30bbffbe2de84bc710bae2ff006fd52a355bee5834b8e965b1";
  database.raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 16").run(altered);

  const results = runMigrations(database.raw);
  assert.equal(results.find((entry) => entry.version === 16).status, "healed");
  const healed = database.raw.prepare("SELECT checksum FROM schema_migrations WHERE version = 16").get().checksum;
  assert.equal(healed, "cdf33ed6d8d0bc2b74aa0fd2d7602ff9d4c60c59ddc0f62eee7324c538af344f",
    "the row is corrected rather than left disagreeing forever");
  assert.equal(database.raw.prepare("SELECT count(*) n FROM conversations").get().n, 1, "and the data is untouched");

  // Healing one named version must not become a general amnesty.
  const tampered = PROFILE_MIGRATIONS.map((entry) =>
    (entry.version === 14 ? { ...entry, sql: `${entry.sql}\n-- edited` } : entry));
  assert.throws(() => runMigrations(database.raw, tampered), (error) => error.code === "MIGRATION_CHECKSUM_MISMATCH");
});
