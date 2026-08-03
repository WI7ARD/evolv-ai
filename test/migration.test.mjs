import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
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
