import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function now() {
  return new Date().toISOString();
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    scryptN: row.scrypt_n,
    scryptR: row.scrypt_r,
    scryptP: row.scrypt_p,
    keyLength: row.key_length,
    recoveryHash: row.recovery_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw Object.assign(new Error("Username must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens."), {
      status: 400,
      code: "INVALID_USERNAME"
    });
  }
  return username;
}

export function createAccountStore({ dataDir, legacyDatabase = null, legacyDbPath = "" }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "accounts.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      scrypt_n INTEGER NOT NULL,
      scrypt_r INTEGER NOT NULL,
      scrypt_p INTEGER NOT NULL,
      key_length INTEGER NOT NULL,
      recovery_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const api = {
    raw: db,
    close: () => db.close(),
    countUsers() {
      return db.prepare("SELECT count(*) AS count FROM users").get().count;
    },
    getOnlyUser() {
      if (api.countUsers() !== 1) return null;
      return mapUser(db.prepare("SELECT * FROM users LIMIT 1").get());
    },
    getUser(id) {
      return mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
    },
    findUser(username) {
      const normalized = String(username || "").trim().toLowerCase();
      return mapUser(db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(normalized));
    },
    listPublicUsers() {
      return db.prepare("SELECT id, username, created_at AS createdAt FROM users ORDER BY username").all();
    },
    createUser(username, credential, { id = crypto.randomUUID() } = {}) {
      if (api.countUsers() >= 25) {
        throw Object.assign(new Error("This Evolv installation already has the maximum of 25 profiles."), { status: 409 });
      }
      const normalized = normalizeUsername(username);
      const timestamp = now();
      try {
        db.prepare(`
          INSERT INTO users
            (id, username, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p,
             key_length, recovery_hash, created_at, updated_at)
          VALUES (@id, @username, @passwordHash, @passwordSalt, @scryptN, @scryptR,
                  @scryptP, @keyLength, @recoveryHash, @createdAt, @updatedAt)
        `).run({
          id,
          username: normalized,
          ...credential,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } catch (error) {
        if (String(error.code).startsWith("SQLITE_CONSTRAINT")) {
          throw Object.assign(new Error("That username is already in use."), { status: 409, code: "USERNAME_TAKEN" });
        }
        throw error;
      }
      if (!api.getMeta("legacy_claimed_by") && legacyDbPath && fs.existsSync(legacyDbPath)) {
        api.setMeta("legacy_claimed_by", id);
        api.setMeta("legacy_source", legacyDbPath);
      }
      return api.getUser(id);
    },
    updateCredential(userId, credential) {
      const result = db.prepare(`
        UPDATE users
        SET password_hash = @passwordHash, password_salt = @passwordSalt,
            scrypt_n = @scryptN, scrypt_r = @scryptR, scrypt_p = @scryptP,
            key_length = @keyLength, recovery_hash = @recoveryHash, updated_at = @updatedAt
        WHERE id = @userId
      `).run({ ...credential, userId, updatedAt: now() });
      if (!result.changes) throw Object.assign(new Error("Account not found."), { status: 404 });
      return api.getUser(userId);
    },
    getMeta(key, fallback = null) {
      return db.prepare("SELECT value FROM account_meta WHERE key = ?").get(key)?.value ?? fallback;
    },
    setMeta(key, value) {
      db.prepare(`
        INSERT INTO account_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    },
    audit(eventType, summary, userId = null) {
      db.transaction(() => {
        db.prepare("INSERT INTO account_audit(id, user_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(crypto.randomUUID(), userId, eventType, String(summary).slice(0, 500), now());
        db.prepare(`
          DELETE FROM account_audit WHERE rowid IN (
            SELECT rowid FROM account_audit ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5000
          )
        `).run();
      })();
    }
  };

  if (!api.countUsers() && legacyDatabase?.getAuthCredential()) {
    const credential = legacyDatabase.getAuthCredential();
    const user = api.createUser("owner", credential);
    api.setMeta("legacy_claimed_by", user.id);
    api.setMeta("legacy_source", legacyDbPath);
    api.audit("account.migrated", "Migrated the original single-user login into the owner profile", user.id);
  }

  return api;
}
