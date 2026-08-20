import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LATEST_SCHEMA_VERSION, PROFILE_MIGRATIONS } from "./schema.mjs";
import { FAILURES_BEFORE_WARNING } from "./model-health.mjs";

const SCHEMA_VERSION = LATEST_SCHEMA_VERSION;

// Checksums a migration is known to have carried before it was corrected.
//
// One migration's SQL was edited in place after it had shipped: the circuits
// table was appended to the end of the physics-scenes migration instead of
// being added as its own. Every database created before that edit recorded the
// original text's checksum, and the check below — working exactly as designed —
// then refused to open any of them. Splitting circuits back out into migration
// 18 restores the original text, which fixes those; but databases created while
// the edit was live recorded the altered checksum and would now be refused for
// the mirror image of the same fault.
//
// So the ledger has to know that this one version legitimately had two texts in
// the wild. A superseded checksum is adopted and healed to the canonical one.
// This is deliberately one named version with one named hash rather than a
// general amnesty: any other mismatch is still a migration that was altered
// after it ran, and is still refused.
const SUPERSEDED_CHECKSUMS = new Map([
  [16, new Set(["e59a098990f7ed30bbffbe2de84bc710bae2ff006fd52a355bee5834b8e965b1"])]
]);

// Applies every migration the database has not recorded yet, in order, each in
// its own transaction with its version, name, and checksum written to the
// ledger. Databases created before the ledger existed carry a bare row for the
// baseline version, so they skip it and pick up only what came after.
export function runMigrations(db, migrations = PROFILE_MIGRATIONS) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(schema_migrations)").all().map((column) => column.name));
  if (!columns.has("name")) db.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!columns.has("checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");

  const applied = new Map(db.prepare("SELECT version, checksum FROM schema_migrations").all().map((row) => [row.version, row.checksum]));
  const record = db.prepare(`
    INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET name = excluded.name, checksum = excluded.checksum
  `);
  const results = [];
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    const checksum = crypto.createHash("sha256").update(migration.sql).digest("hex");
    if (applied.has(migration.version)) {
      const previous = applied.get(migration.version);
      // A pre-ledger row has no checksum to compare against; adopt it rather
      // than replaying schema the database demonstrably already has.
      if (!previous) record.run(migration.version, migration.name, checksum, now());
      else if (previous !== checksum) {
        if (SUPERSEDED_CHECKSUMS.get(migration.version)?.has(previous)) {
          record.run(migration.version, migration.name, checksum, now());
          results.push({ ...migration, status: "healed" });
          continue;
        }
        // Named plainly, because the data is fine and the person needs to know
        // that. A schema file that no longer matches what a database ran is a
        // build mistake, not a corrupt profile, and the difference decides
        // whether someone reaches for a backup they do not need.
        throw Object.assign(
          new Error(`Migration ${migration.version} (${migration.name}) was altered after it was applied, so Evolv cannot confirm this database matches the schema it expects. The data itself is intact — this is a problem with the build, not with the profile.`),
          { code: "MIGRATION_CHECKSUM_MISMATCH", expose: true, status: 500 }
        );
      }
      results.push({ ...migration, status: "already-applied" });
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, checksum, now());
    })();
    results.push({ ...migration, status: "applied" });
  }
  return results;
}

function now() {
  return new Date().toISOString();
}

function encodeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  return Buffer.from(new Float32Array(vector).buffer);
}

function decodeVector(buffer) {
  if (!buffer) return null;
  const bytes = Buffer.from(buffer);
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from(view);
}

function parseJson(value, fallback = null) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createDatabase({ dataDir, legacyStateFile, defaultPrompt, baselineUpgrade = null, dbPath = path.join(dataDir, "evolv.db") }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const backupsDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // Schema lives in lib/schema.mjs and is applied through the recorded
  // ledger, so a profile always opens with every table it needs.
  runMigrations(db);

  db.prepare("INSERT OR IGNORE INTO app_meta(key, value) VALUES ('active_version_id', 'v1')").run();
  db.prepare("INSERT OR IGNORE INTO app_meta(key, value) VALUES ('pending_proposal', 'null')").run();
  db.prepare(`
    INSERT OR IGNORE INTO prompt_versions
      (id, number, prompt, summary, rationale, tests_json, source, created_at)
    VALUES ('v1', 1, ?, 'Original behavior', 'The safe baseline prompt shipped with Evolv.', '[]', 'baseline', ?)
  `).run(defaultPrompt, now());
  if (baselineUpgrade?.id && baselineUpgrade?.prompt) {
    const receiptKey = `baseline_upgrade:${baselineUpgrade.id}`;
    const applied = db.prepare("SELECT 1 FROM app_meta WHERE key = ?").get(receiptKey);
    if (!applied) {
      db.transaction(() => {
      const existing = db.prepare("SELECT id FROM prompt_versions WHERE id = ?").get(baselineUpgrade.id);
      if (!existing) {
        const number = (db.prepare("SELECT COALESCE(MAX(number), 0) AS value FROM prompt_versions").get()?.value || 0) + 1;
        db.prepare(`
          INSERT INTO prompt_versions(id, number, prompt, summary, rationale, tests_json, source, created_at)
          VALUES (?, ?, ?, ?, ?, '[]', 'personal-baseline-upgrade', ?)
        `).run(
          baselineUpgrade.id,
          number,
          baselineUpgrade.prompt,
          baselineUpgrade.summary || "Commercial engineer personality",
          baselineUpgrade.rationale || "User-requested, reversible baseline personality upgrade.",
          now()
        );
      }
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'active_version_id'").run(baselineUpgrade.id);
        db.prepare("INSERT INTO app_meta(key, value) VALUES (?, ?)").run(receiptKey, now());
      })();
    }
  }

  const api = {
    raw: db,
    path: dbPath,
    backupsDir,
    close: () => db.close(),
    integrityCheck() {
      return db.pragma("integrity_check", { simple: true }) === "ok";
    },
    reconcileAfterRestart() {
      const recoveredAt = now();
      return db.transaction(() => {
        const streamingMessages = db.prepare(`
          SELECT id, metadata_json AS metadataJson
          FROM messages
          WHERE role = 'assistant' AND status = 'streaming'
        `).all();
        const updateMessage = db.prepare(`
          UPDATE messages SET status = 'interrupted', metadata_json = ?, updated_at = ? WHERE id = ?
        `);
        for (const message of streamingMessages) {
          const metadata = parseJson(message.metadataJson, {});
          updateMessage.run(JSON.stringify({
            ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
            recovery: { reason: "application-restarted", recoveredAt }
          }), recoveredAt, message.id);
        }
        const toolRuns = db.prepare(`
          UPDATE tool_runs
          SET status = 'failed', error = 'APPLICATION_RESTARTED: tool execution was interrupted.', completed_at = ?
          WHERE status = 'running' AND completed_at IS NULL
        `).run(recoveredAt).changes;
        const routingEvents = db.prepare(`
          UPDATE routing_events
          SET status = 'interrupted', outcome = 'application restarted before completion', completed_at = ?
          WHERE status = 'selected' AND completed_at IS NULL
        `).run(recoveredAt).changes;
        const evaluationRuns = db.prepare(`
          UPDATE evaluation_runs
          SET status = 'failed', summary_json = ?, completed_at = ?
          WHERE status = 'running' AND completed_at IS NULL
        `).run(JSON.stringify({ error: "APPLICATION_RESTARTED", recoveredAt }), recoveredAt).changes;
        const counts = {
          messages: streamingMessages.length,
          toolRuns,
          routingEvents,
          evaluationRuns
        };
        if (Object.values(counts).some((count) => count > 0)) {
          db.prepare(`
            INSERT INTO audit_events(id, event_type, entity_type, entity_id, summary, metadata_json, created_at)
            VALUES (?, 'recovery.startup-reconciled', NULL, NULL, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            `Recovered ${Object.values(counts).reduce((sum, count) => sum + count, 0)} interrupted record(s) after restart`,
            JSON.stringify(counts),
            recoveredAt
          );
        }
        return counts;
      })();
    },
    getMeta(key, fallback = null) {
      const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
      return row ? row.value : fallback;
    },
    setMeta(key, value) {
      db.prepare(`
        INSERT INTO app_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    },
    getSettings() {
      return Object.fromEntries(db.prepare("SELECT key, value_json FROM settings").all()
        .map((row) => [row.key, parseJson(row.value_json)]));
    },
    patchSettings(values) {
      const statement = db.prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `);
      db.transaction(() => {
        for (const [key, value] of Object.entries(values || {})) {
          statement.run(key, JSON.stringify(value), now());
        }
      })();
      return api.getSettings();
    },
    getState() {
      const versions = db.prepare("SELECT * FROM prompt_versions ORDER BY number").all().map((row) => ({
        id: row.id,
        number: row.number,
        prompt: row.prompt,
        summary: row.summary,
        rationale: row.rationale,
        tests: parseJson(row.tests_json, []),
        source: row.source,
        evaluatorModel: row.evaluator_model,
        createdAt: row.created_at
      }));
      const feedback = db.prepare("SELECT * FROM feedback ORDER BY created_at").all().map((row) => ({
        id: row.id,
        messageId: row.message_id,
        conversationId: row.conversation_id,
        rating: row.rating,
        note: row.note,
        userMessage: row.user_message,
        assistantMessage: row.assistant_message,
        model: row.model,
        versionId: row.version_id,
        createdAt: row.created_at
      }));
      const knowledge = db.prepare("SELECT * FROM knowledge ORDER BY created_at").all().map((row) => ({
        id: row.id,
        title: row.title,
        domain: row.domain,
        content: row.content,
        embedding: decodeVector(row.embedding),
        embeddingModel: row.embedding_model,
        embeddingStatus: row.embedding_status,
        source: row.source,
        createdAt: row.created_at
      }));
      const architectureProposals = db.prepare("SELECT * FROM architecture_proposals ORDER BY created_at").all().map((row) => ({
        id: row.id,
        request: row.request,
        model: row.model,
        title: row.title,
        summary: row.summary,
        rationale: row.rationale,
        changes: parseJson(row.changes_json, []),
        risks: parseJson(row.risks_json, []),
        tests: parseJson(row.tests_json, []),
        status: row.status,
        createdAt: row.created_at
      }));
      return {
        schemaVersion: SCHEMA_VERSION,
        activeVersionId: api.getMeta("active_version_id", versions[0]?.id || "v1"),
        versions,
        feedback,
        pendingProposal: parseJson(api.getMeta("pending_proposal", "null")),
        knowledge,
        architectureProposals,
        settings: api.getSettings()
      };
    },
    // Merges an aggregate into the four prompt/feedback/knowledge/architecture
    // tables. This used to DELETE all four and reinsert the caller's snapshot,
    // which silently discarded anything written after that snapshot was taken.
    // It now only adds what is missing, so a stale aggregate can no longer
    // destroy a concurrent write. Removing a record is an explicit operation
    // (see deleteKnowledge); it is deliberately not expressible here.
    //
    // Its remaining callers are bulk merges — portable import and the legacy
    // state.json migration. Single-record changes use the targeted writers
    // below instead.
    saveState(state) {
      const insertVersion = db.prepare(`
        INSERT OR IGNORE INTO prompt_versions(id, number, prompt, summary, rationale, tests_json, source, evaluator_model, created_at)
        VALUES (@id, @number, @prompt, @summary, @rationale, @tests, @source, @evaluatorModel, @createdAt)
      `);
      const insertFeedback = db.prepare(`
        INSERT OR IGNORE INTO feedback(id, message_id, conversation_id, rating, note, user_message, assistant_message, model, version_id, created_at)
        VALUES (@id, @messageId, @conversationId, @rating, @note, @userMessage, @assistantMessage, @model, @versionId, @createdAt)
      `);
      const insertKnowledge = db.prepare(`
        INSERT OR IGNORE INTO knowledge(id, title, domain, content, embedding, embedding_model, embedding_status, source, created_at, updated_at)
        VALUES (@id, @title, @domain, @content, @embedding, @embeddingModel, @embeddingStatus, @source, @createdAt, @updatedAt)
      `);
      const insertArchitecture = db.prepare(`
        INSERT OR IGNORE INTO architecture_proposals(id, request, model, title, summary, rationale, changes_json, risks_json, tests_json, status, created_at)
        VALUES (@id, @request, @model, @title, @summary, @rationale, @changes, @risks, @tests, @status, @createdAt)
      `);
      db.transaction(() => {
        for (const item of state.versions || []) insertVersion.run({
          id: item.id,
          number: item.number,
          prompt: item.prompt,
          summary: item.summary || "",
          rationale: item.rationale || "",
          tests: JSON.stringify(item.tests || []),
          source: item.source || "imported",
          evaluatorModel: item.evaluatorModel || null,
          createdAt: item.createdAt || now()
        });
        for (const item of state.feedback || []) insertFeedback.run({
          id: item.id || crypto.randomUUID(),
          messageId: item.messageId || null,
          conversationId: item.conversationId || null,
          rating: item.rating,
          note: item.note || "",
          userMessage: item.userMessage || "",
          assistantMessage: item.assistantMessage || "",
          model: item.model || "",
          versionId: item.versionId || null,
          createdAt: item.createdAt || now()
        });
        for (const item of state.knowledge || []) insertKnowledge.run({
          id: item.id || crypto.randomUUID(),
          title: item.title,
          domain: item.domain || "General",
          content: item.content,
          embedding: encodeVector(item.embedding),
          embeddingModel: item.embeddingModel || "",
          embeddingStatus: item.embeddingStatus || (item.embedding ? "semantic" : "lexical"),
          source: item.source || "user-approved",
          createdAt: item.createdAt || now(),
          updatedAt: item.updatedAt || item.createdAt || now()
        });
        for (const item of state.architectureProposals || []) insertArchitecture.run({
          id: item.id || crypto.randomUUID(),
          request: item.request || "",
          model: item.model || "",
          title: item.title || "Proposal",
          summary: item.summary || "",
          rationale: item.rationale || "",
          changes: JSON.stringify(item.changes || []),
          risks: JSON.stringify(item.risks || []),
          tests: JSON.stringify(item.tests || []),
          status: item.status || "proposal-only",
          createdAt: item.createdAt || now()
        });
        api.setMeta("active_version_id", state.activeVersionId || state.versions?.[0]?.id || "v1");
        api.setMeta("pending_proposal", JSON.stringify(state.pendingProposal || null));
        if (state.settings) api.patchSettings(state.settings);
      })();
    },
    // Keeps the newest `keep` rows of a bounded log table. The aggregate path
    // used to enforce these ceilings by slicing an in-memory array; doing it in
    // SQL keeps the bound without reading the table into the process. rowid
    // breaks ties so rows written within the same millisecond stay ordered.
    pruneBoundedTable(table, keep) {
      if (!["feedback", "knowledge", "architecture_proposals"].includes(table)) {
        throw new Error(`Refusing to prune unknown table ${table}.`);
      }
      db.prepare(`
        DELETE FROM ${table} WHERE id NOT IN (
          SELECT id FROM ${table} ORDER BY created_at DESC, rowid DESC LIMIT ?
        )
      `).run(Math.max(1, keep));
    },
    // Saved physics scenes. Saving under a name that already exists overwrites
    // it, because the alternative is a list slowly filling with "ramp test 4".
    savePhysicsScene({ name, snapshot, objectCount = 0 }, { keep = 50 } = {}) {
      const title = String(name || "").trim().slice(0, 80);
      if (!title) throw Object.assign(new Error("A scene needs a name."), { status: 400, code: "SCENE_NAME_REQUIRED" });
      const now = new Date().toISOString();
      return db.transaction(() => {
        const existing = db.prepare("SELECT id, created_at FROM physics_scenes WHERE name = ?").get(title);
        const id = existing?.id || crypto.randomUUID();
        db.prepare(`
          INSERT INTO physics_scenes(id, name, snapshot_json, object_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            object_count = excluded.object_count,
            updated_at = excluded.updated_at
        `).run(id, title, JSON.stringify(snapshot), Number(objectCount) || 0, existing?.created_at || now, now);
        db.prepare(`
          DELETE FROM physics_scenes WHERE id NOT IN (
            SELECT id FROM physics_scenes ORDER BY updated_at DESC, rowid DESC LIMIT ?
          )
        `).run(Math.max(1, keep));
        return { id, name: title, objectCount: Number(objectCount) || 0, updatedAt: now };
      })();
    },
    listPhysicsScenes({ limit = 50 } = {}) {
      return db.prepare(`
        SELECT id, name, object_count AS objectCount, created_at AS createdAt, updated_at AS updatedAt
        FROM physics_scenes ORDER BY updated_at DESC, rowid DESC LIMIT ?
      `).all(Math.max(1, Math.min(200, Number(limit) || 50)));
    },
    getPhysicsScene(id) {
      const row = db.prepare("SELECT id, name, snapshot_json AS snapshotJson FROM physics_scenes WHERE id = ?").get(String(id || ""));
      if (!row) return null;
      try {
        return { id: row.id, name: row.name, snapshot: JSON.parse(row.snapshotJson) };
      } catch {
        // A row that will not parse is worse than a missing one: it would fail
        // deep inside restore with a message about the solver.
        throw Object.assign(new Error("That saved scene is unreadable."), { status: 422, code: "SCENE_CORRUPT" });
      }
    },
    deletePhysicsScene(id) {
      return db.prepare("DELETE FROM physics_scenes WHERE id = ?").run(String(id || "")).changes > 0;
    },
    // Saved circuits. Deliberately the same shape as the physics scenes above:
    // an opaque snapshot the service understands and the database does not, so
    // the simulator keeps no database handle and stays memory-only — which is
    // what keeps its tools in the automatic risk tier.
    saveCircuit({ name, snapshot, partCount = 0 }, { keep = 50 } = {}) {
      const title = String(name || "").trim().slice(0, 80);
      if (!title) throw Object.assign(new Error("A circuit needs a name."), { status: 400, code: "CIRCUIT_NAME_REQUIRED" });
      const now = new Date().toISOString();
      return db.transaction(() => {
        const existing = db.prepare("SELECT id, created_at FROM circuits WHERE name = ?").get(title);
        const id = existing?.id || crypto.randomUUID();
        db.prepare(`
          INSERT INTO circuits(id, name, snapshot_json, part_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            part_count = excluded.part_count,
            updated_at = excluded.updated_at
        `).run(id, title, JSON.stringify(snapshot), Number(partCount) || 0, existing?.created_at || now, now);
        db.prepare(`
          DELETE FROM circuits WHERE id NOT IN (
            SELECT id FROM circuits ORDER BY updated_at DESC, rowid DESC LIMIT ?
          )
        `).run(Math.max(1, keep));
        return { id, name: title, partCount: Number(partCount) || 0, updatedAt: now };
      })();
    },
    listCircuits({ limit = 50 } = {}) {
      return db.prepare(`
        SELECT id, name, part_count AS partCount, created_at AS createdAt, updated_at AS updatedAt
        FROM circuits ORDER BY updated_at DESC, rowid DESC LIMIT ?
      `).all(Math.max(1, Math.min(200, Number(limit) || 50)));
    },
    getCircuit(id) {
      const row = db.prepare("SELECT id, name, snapshot_json AS snapshotJson FROM circuits WHERE id = ?").get(String(id || ""));
      if (!row) return null;
      try {
        return { id: row.id, name: row.name, snapshot: JSON.parse(row.snapshotJson) };
      } catch {
        throw Object.assign(new Error("That saved circuit is unreadable."), { status: 422, code: "CIRCUIT_CORRUPT" });
      }
    },
    deleteCircuit(id) {
      return db.prepare("DELETE FROM circuits WHERE id = ?").run(String(id || "")).changes > 0;
    },
    addFeedback(item, { keep = 500 } = {}) {
      return db.transaction(() => {
        db.prepare(`
          INSERT INTO feedback(id, message_id, conversation_id, rating, note, user_message, assistant_message, model, version_id, created_at)
          VALUES (@id, @messageId, @conversationId, @rating, @note, @userMessage, @assistantMessage, @model, @versionId, @createdAt)
        `).run({
          id: item.id || crypto.randomUUID(),
          messageId: item.messageId || null,
          conversationId: item.conversationId || null,
          rating: item.rating,
          note: item.note || "",
          userMessage: item.userMessage || "",
          assistantMessage: item.assistantMessage || "",
          model: item.model || "",
          versionId: item.versionId || null,
          createdAt: item.createdAt || now()
        });
        api.pruneBoundedTable("feedback", keep);
        return item;
      })();
    },
    addPromptVersion(version) {
      db.prepare(`
        INSERT INTO prompt_versions(id, number, prompt, summary, rationale, tests_json, source, evaluator_model, created_at)
        VALUES (@id, @number, @prompt, @summary, @rationale, @tests, @source, @evaluatorModel, @createdAt)
      `).run({
        id: version.id,
        number: version.number,
        prompt: version.prompt,
        summary: version.summary || "",
        rationale: version.rationale || "",
        tests: JSON.stringify(version.tests || []),
        source: version.source || "imported",
        evaluatorModel: version.evaluatorModel || null,
        createdAt: version.createdAt || now()
      });
      return version;
    },
    addKnowledge(item, { keep = 1000 } = {}) {
      return db.transaction(() => {
        db.prepare(`
          INSERT INTO knowledge(id, title, domain, content, embedding, embedding_model, embedding_status, source, created_at, updated_at)
          VALUES (@id, @title, @domain, @content, @embedding, @embeddingModel, @embeddingStatus, @source, @createdAt, @updatedAt)
        `).run({
          id: item.id || crypto.randomUUID(),
          title: item.title,
          domain: item.domain || "General",
          content: item.content,
          embedding: encodeVector(item.embedding),
          embeddingModel: item.embeddingModel || "",
          embeddingStatus: item.embeddingStatus || (item.embedding ? "semantic" : "lexical"),
          source: item.source || "user-approved",
          createdAt: item.createdAt || now(),
          updatedAt: item.updatedAt || item.createdAt || now()
        });
        api.pruneBoundedTable("knowledge", keep);
        return item;
      })();
    },
    deleteKnowledge(id) {
      return db.prepare("DELETE FROM knowledge WHERE id = ?").run(id).changes > 0;
    },
    addArchitectureProposal(item, { keep = 100 } = {}) {
      return db.transaction(() => {
        db.prepare(`
          INSERT INTO architecture_proposals(id, request, model, title, summary, rationale, changes_json, risks_json, tests_json, status, created_at)
          VALUES (@id, @request, @model, @title, @summary, @rationale, @changes, @risks, @tests, @status, @createdAt)
        `).run({
          id: item.id || crypto.randomUUID(),
          request: item.request || "",
          model: item.model || "",
          title: item.title || "Proposal",
          summary: item.summary || "",
          rationale: item.rationale || "",
          changes: JSON.stringify(item.changes || []),
          risks: JSON.stringify(item.risks || []),
          tests: JSON.stringify(item.tests || []),
          status: item.status || "proposal-only",
          createdAt: item.createdAt || now()
        });
        api.pruneBoundedTable("architecture_proposals", keep);
        return item;
      })();
    },
    setActiveVersion(versionId) {
      api.setMeta("active_version_id", versionId);
    },
    setPendingProposal(proposal) {
      api.setMeta("pending_proposal", JSON.stringify(proposal || null));
    },
    createConversation({ title = "New conversation", id = crypto.randomUUID(), createdAt = now() } = {}) {
      db.prepare(`
        INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(id, title.slice(0, 200), createdAt, createdAt);
      return api.getConversation(id);
    },
    listConversations({ query = "", status = "active", limit = 50, cursor = "" } = {}) {
      const clauses = [];
      const args = {};
      if (status === "trash") clauses.push("deleted_at IS NOT NULL");
      else {
        clauses.push("deleted_at IS NULL");
        clauses.push(status === "archived" ? "archived_at IS NOT NULL" : "archived_at IS NULL");
      }
      if (query) {
        clauses.push("(title LIKE @query OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.content LIKE @query))");
        args.query = `%${query.slice(0, 200)}%`;
      }
      if (cursor) {
        clauses.push("updated_at < @cursor");
        args.cursor = cursor;
      }
      args.limit = Math.max(1, Math.min(100, Number(limit) || 50));
      return db.prepare(`
        SELECT id, title, created_at AS createdAt, updated_at AS updatedAt,
               archived_at AS archivedAt, deleted_at AS deletedAt,
               (SELECT substr(content, 1, 180) FROM messages m WHERE m.conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS preview,
               (SELECT count(*) FROM messages m WHERE m.conversation_id = conversations.id) AS messageCount
        FROM conversations
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT @limit
      `).all(args);
    },
    getConversation(id) {
      const conversation = db.prepare(`
        SELECT id, title, created_at AS createdAt, updated_at AS updatedAt,
               archived_at AS archivedAt, deleted_at AS deletedAt
        FROM conversations WHERE id = ?
      `).get(id);
      if (!conversation) return null;
      conversation.messages = db.prepare(`
        SELECT id, role, content, thinking, model, mode, status, tool_name AS toolName,
               tool_call_id AS toolCallId, metadata_json AS metadataJson,
               created_at AS createdAt, updated_at AS updatedAt
        FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid
      `).all(id).map((row) => ({ ...row, metadata: parseJson(row.metadataJson, {}), metadataJson: undefined }));
      return conversation;
    },
    updateConversation(id, patch = {}) {
      const current = api.getConversation(id);
      if (!current) return null;
      const title = patch.title == null ? current.title : String(patch.title).trim().slice(0, 200) || current.title;
      const archivedAt = patch.archived === true ? now() : patch.archived === false ? null : current.archivedAt;
      db.prepare("UPDATE conversations SET title = ?, archived_at = ?, updated_at = ? WHERE id = ?")
        .run(title, archivedAt, now(), id);
      return api.getConversation(id);
    },
    trashConversation(id) {
      return db.prepare("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id).changes > 0;
    },
    restoreConversation(id) {
      return db.prepare("UPDATE conversations SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now(), id).changes > 0;
    },
    deleteConversation(id) {
      return db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
    },
    addMessage({ id = crypto.randomUUID(), conversationId, role, content = "", thinking = "", model = null, mode = null, status = "complete", toolName = null, toolCallId = null, metadata = {}, createdAt = now() }) {
      db.prepare(`
        INSERT INTO messages(id, conversation_id, role, content, thinking, model, mode, status, tool_name, tool_call_id, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, conversationId, role, content, thinking, model, mode, status, toolName, toolCallId, JSON.stringify(metadata), createdAt, createdAt);
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
      return id;
    },
    // A success wipes the slate rather than decrementing: a model that answers
    // is working now, whatever it did yesterday.
    recordModelResult({ provider, model, ok, reason = "", permanent = false }) {
      const key = [String(provider || ""), String(model || "")];
      if (!key[0] || !key[1]) return null;
      const at = now();
      if (ok) {
        db.prepare(`INSERT INTO model_health(provider,model,failures,reason,last_ok_at,updated_at)
          VALUES (?,?,0,'',?,?)
          ON CONFLICT(provider,model) DO UPDATE SET failures=0, reason='', last_ok_at=excluded.last_ok_at, updated_at=excluded.updated_at`)
          .run(...key, at, at);
      } else {
        // A permanent failure — the provider saying a model is retired — starts
        // at the warning threshold instead of climbing to it. The count means
        // "consecutive failures, floored where the provider has already told us
        // the answer", which is why one retirement warns and one timeout does
        // not. A success still resets it to zero, so a model that comes back
        // clears its record like any other.
        const floor = permanent ? FAILURES_BEFORE_WARNING : 1;
        db.prepare(`INSERT INTO model_health(provider,model,failures,reason,last_failed_at,updated_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(provider,model) DO UPDATE SET failures=MAX(model_health.failures+1, ?),
            reason=excluded.reason, last_failed_at=excluded.last_failed_at, updated_at=excluded.updated_at`)
          .run(...key, floor, String(reason).slice(0, 200), at, at, floor);
      }
      return api.getModelHealth(provider, model);
    },
    getModelHealth(provider, model) {
      return db.prepare(`SELECT provider, model, failures, reason, last_ok_at AS lastOkAt,
        last_failed_at AS lastFailedAt FROM model_health WHERE provider=? AND model=?`)
        .get(String(provider || ""), String(model || "")) || null;
    },
    // With no provider this returns every row: Auto routing weighs models from
    // all providers at once and needs the whole record, not one provider's.
    listModelHealth(provider) {
      const columns = `provider, model, failures, reason, last_ok_at AS lastOkAt, last_failed_at AS lastFailedAt`;
      return provider
        ? db.prepare(`SELECT ${columns} FROM model_health WHERE provider=?`).all(String(provider))
        : db.prepare(`SELECT ${columns} FROM model_health`).all();
    },
    // Removes a message and everything after it. Editing a question means the
    // answers that followed it were answers to a question nobody asked, so they
    // go with it — ordered by the same (created_at, rowid) the reader uses, or
    // two messages written in the same millisecond could survive out of order.
    deleteMessagesFrom(conversationId, messageId) {
      const target = db.prepare("SELECT rowid, created_at FROM messages WHERE id = ? AND conversation_id = ?")
        .get(String(messageId || ""), String(conversationId || ""));
      if (!target) return 0;
      const removed = db.prepare(`DELETE FROM messages WHERE conversation_id = ?
        AND (created_at > ? OR (created_at = ? AND rowid >= ?))`)
        .run(String(conversationId), target.created_at, target.created_at, target.rowid).changes;
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), String(conversationId));
      return removed;
    },
    updateMessage(id, patch = {}) {
      const current = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      if (!current) return false;
      db.prepare(`
        UPDATE messages SET content = ?, thinking = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?
      `).run(
        patch.content ?? current.content,
        patch.thinking ?? current.thinking,
        patch.status ?? current.status,
        JSON.stringify(patch.metadata ?? parseJson(current.metadata_json, {})),
        now(),
        id
      );
      return true;
    },
    getChatMessages(conversationId, limit = 80) {
      return db.prepare(`
        SELECT role, content, thinking, tool_name AS tool_name, tool_call_id AS tool_call_id, metadata_json
        FROM (
          SELECT *, rowid AS ordering FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        ) ORDER BY created_at, ordering
      `).all(conversationId, limit).map((row) => {
        const metadata = parseJson(row.metadata_json, {});
        return {
          role: row.role,
          content: row.content,
          ...(row.thinking ? { thinking: row.thinking } : {}),
          ...(row.tool_name ? { tool_name: row.tool_name } : {}),
          ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
          // An empty array is truthy, and OpenAI rejects `tool_calls: []` with a
          // 400 naming a message index nobody can map back to a turn. The
          // images line below already had this right.
          ...(Array.isArray(metadata.tool_calls) && metadata.tool_calls.length
            ? { tool_calls: metadata.tool_calls } : {}),
          // The provider's own account of the turn, handed back verbatim on the
          // next request. Opaque to everything between here and the adapter.
          ...(Array.isArray(metadata.provider_state) && metadata.provider_state.length
            ? { provider_state: metadata.provider_state } : {}),
          ...(Array.isArray(metadata.images) && metadata.images.length ? { images: metadata.images } : {})
        };
      });
    },
    autoTitleConversation(id, userText) {
      const row = db.prepare("SELECT title FROM conversations WHERE id = ?").get(id);
      if (row?.title === "New conversation") {
        const title = userText.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
        db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), id);
      }
    },
    getToolConfig() {
      return Object.fromEntries(db.prepare("SELECT name, enabled FROM tool_config").all().map((row) => [row.name, Boolean(row.enabled)]));
    },
    setToolConfig(name, enabled, risk = "read") {
      db.prepare(`
        INSERT INTO tool_config(name, enabled, risk, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
      `).run(name, enabled ? 1 : 0, risk, now());
    },
    createToolRun(item) {
      db.prepare(`
        INSERT INTO tool_runs(id, conversation_id, message_id, tool_name, arguments_json, risk, decision, status, created_at)
        VALUES (@id, @conversationId, @messageId, @toolName, @arguments, @risk, @decision, @status, @createdAt)
      `).run({ ...item, createdAt: item.createdAt || now() });
    },
    finishToolRun(id, { status, resultSummary = "", error = "", durationMs = 0 }) {
      db.prepare(`
        UPDATE tool_runs SET status = ?, result_summary = ?, error = ?, duration_ms = ?, completed_at = ? WHERE id = ?
      `).run(status, resultSummary, error, durationMs, now(), id);
    },
    // The stored result of a tool call that already ran in this conversation.
    //
    // Keyed on a signature written into the tool message's metadata rather than
    // on the call id, because the point is to recognise the same request when a
    // provider gives it a new id — which it does on every resumed turn.
    //
    // json_extract rather than a scan: the conversation index narrows it to one
    // conversation and SQLite evaluates the extraction over what is left, which
    // is a few dozen rows even in a long chat.
    //
    // The json_valid guard is not defensive decoration. json_extract raises
    // "malformed JSON" rather than returning null, so a single unparseable
    // metadata column anywhere in the conversation — a half-written row after a
    // crash, a hand-edited database — would throw here and take down every turn
    // in that conversation, for a lookup that is only an optimisation.
    findToolCheckpoint(conversationId, signature) {
      if (!conversationId || !signature) return null;
      const row = db.prepare(`
        SELECT id, tool_name AS toolName, content, metadata_json AS metadataJson, created_at AS createdAt
        FROM messages
        WHERE conversation_id = ? AND role = 'tool' AND status = 'complete'
          AND (CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.checkpoint') END) = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(conversationId, signature);
      if (!row) return null;
      const metadata = parseJson(row.metadataJson, {});
      return {
        messageId: row.id,
        toolName: row.toolName,
        output: row.content,
        runId: metadata.runId || null,
        at: row.createdAt
      };
    },
    listToolRuns(limit = 100) {
      return db.prepare(`
        SELECT id, conversation_id AS conversationId, message_id AS messageId, tool_name AS toolName,
               arguments_json AS argumentsJson, risk, decision, status, result_summary AS resultSummary,
               error, duration_ms AS durationMs, created_at AS createdAt, completed_at AS completedAt
        FROM tool_runs ORDER BY created_at DESC LIMIT ?
      `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => ({
        ...row,
        arguments: parseJson(row.argumentsJson, {}),
        argumentsJson: undefined
      }));
    },
    listMemoryNodes({ status = "", type = "" } = {}) {
      const clauses = [];
      const args = {};
      if (status) { clauses.push("status = @status"); args.status = status; }
      if (type) { clauses.push("type = @type"); args.type = type; }
      return db.prepare(`
        SELECT id, type, title, body, status, source, conversation_id AS conversationId,
               embedding, embedding_model AS embeddingModel, embedding_status AS embeddingStatus,
               created_at AS createdAt, updated_at AS updatedAt
        FROM memory_nodes ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY updated_at DESC
      `).all(args).map((row) => ({ ...row, embedding: decodeVector(row.embedding) }));
    },
    getMemoryNode(id) {
      const node = api.listMemoryNodes().find((item) => item.id === id);
      if (!node) return null;
      node.edges = api.listMemoryEdges().filter((edge) => edge.fromId === id || edge.toId === id);
      return node;
    },
    addMemoryNode({ id = crypto.randomUUID(), type, title, body = "", status = "active", source = "user", conversationId = null, embedding = null, embeddingModel = "", embeddingStatus = "lexical", createdAt = now() }) {
      db.prepare(`
        INSERT INTO memory_nodes(id, type, title, body, status, source, conversation_id, embedding, embedding_model, embedding_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, type, title.slice(0, 200), body.slice(0, 10_000), status, source, conversationId, encodeVector(embedding), embeddingModel, embeddingStatus, createdAt, createdAt);
      return api.getMemoryNode(id);
    },
    updateMemoryNode(id, patch = {}) {
      const current = db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id);
      if (!current) return null;
      db.prepare(`
        UPDATE memory_nodes SET type = ?, title = ?, body = ?, status = ?, embedding = ?, embedding_model = ?, embedding_status = ?, updated_at = ? WHERE id = ?
      `).run(
        patch.type ?? current.type,
        (patch.title ?? current.title).slice(0, 200),
        (patch.body ?? current.body).slice(0, 10_000),
        patch.status ?? current.status,
        patch.embedding !== undefined ? encodeVector(patch.embedding) : current.embedding,
        patch.embeddingModel ?? current.embedding_model,
        patch.embeddingStatus ?? current.embedding_status,
        now(),
        id
      );
      return api.getMemoryNode(id);
    },
    deleteMemoryNode(id) {
      return db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id).changes > 0;
    },
    listMemoryEdges() {
      return db.prepare(`
        SELECT id, from_id AS fromId, to_id AS toId, relation, created_at AS createdAt
        FROM memory_edges ORDER BY created_at
      `).all();
    },
    addMemoryEdge({ id = crypto.randomUUID(), fromId, toId, relation = "relates-to" }) {
      db.prepare(`
        INSERT OR IGNORE INTO memory_edges(id, from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, fromId, toId, relation.slice(0, 60), now());
      return api.listMemoryEdges().find((edge) => edge.fromId === fromId && edge.toId === toId && edge.relation === relation.slice(0, 60)) || null;
    },
    deleteMemoryEdge(id) {
      return db.prepare("DELETE FROM memory_edges WHERE id = ?").run(id).changes > 0;
    },
    getMemoryGraph() {
      return {
        nodes: api.listMemoryNodes().map(({ embedding, ...node }) => node),
        edges: api.listMemoryEdges()
      };
    },
    listModelPreferences() {
      return db.prepare(`
        SELECT provider_id AS providerId, model_id AS modelId, enabled_auto AS enabledAuto,
               quality, speed, cost, privacy, updated_at AS updatedAt
        FROM model_preferences ORDER BY provider_id, model_id
      `).all().map((row) => ({ ...row, enabledAuto: Boolean(row.enabledAuto) }));
    },
    saveModelPreference(providerId, modelId, patch = {}) {
      const existing = db.prepare("SELECT * FROM model_preferences WHERE provider_id = ? AND model_id = ?").get(providerId, modelId);
      const bounded = (value, fallback, minimum = 1) => Math.max(minimum, Math.min(5, Math.round(Number(value ?? fallback))));
      db.prepare(`
        INSERT INTO model_preferences(provider_id, model_id, enabled_auto, quality, speed, cost, privacy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, model_id) DO UPDATE SET enabled_auto = excluded.enabled_auto,
          quality = excluded.quality, speed = excluded.speed, cost = excluded.cost,
          privacy = excluded.privacy, updated_at = excluded.updated_at
      `).run(
        String(providerId).slice(0, 50), String(modelId).slice(0, 300),
        patch.enabledAuto === undefined ? (existing?.enabled_auto ?? 1) : patch.enabledAuto ? 1 : 0,
        bounded(patch.quality, existing?.quality ?? 3), bounded(patch.speed, existing?.speed ?? 3),
        bounded(patch.cost, existing?.cost ?? 2, 0), bounded(patch.privacy, existing?.privacy ?? 3), now()
      );
      return api.listModelPreferences().find((item) => item.providerId === providerId && item.modelId === modelId);
    },
    createRoutingEvent(item) {
      const id = item.id || crypto.randomUUID();
      db.prepare(`
        INSERT INTO routing_events(id, conversation_id, message_id, provider_id, model_id, requested_model,
          task_json, reasons_json, considered_json, score, cloud, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.conversationId || null, item.messageId || null, item.providerId, item.modelId,
        item.requestedModel || "auto", JSON.stringify(item.task || {}), JSON.stringify(item.reasons || []),
        JSON.stringify(item.considered || []), Number(item.score) || 0, item.cloud ? 1 : 0,
        item.status || "selected", item.createdAt || now());
      return id;
    },
    finishRoutingEvent(id, { messageId = null, status = "complete", outcome = "" } = {}) {
      db.prepare(`UPDATE routing_events SET message_id = COALESCE(?, message_id), status = ?, outcome = ?, completed_at = ? WHERE id = ?`)
        .run(messageId, status, String(outcome).slice(0, 500), now(), id);
    },
    recordRoutingOutcome(messageId, outcome) {
      if (!messageId || !["up", "down"].includes(outcome)) return false;
      return db.prepare("UPDATE routing_events SET outcome = ? WHERE message_id = ?")
        .run(outcome, messageId).changes > 0;
    },
    listRoutingEvents(limit = 100) {
      return db.prepare(`
        SELECT id, conversation_id AS conversationId, message_id AS messageId, provider_id AS providerId,
          model_id AS modelId, requested_model AS requestedModel, task_json AS taskJson,
          reasons_json AS reasonsJson, considered_json AS consideredJson, score, cloud, status, outcome,
          created_at AS createdAt, completed_at AS completedAt
        FROM routing_events ORDER BY created_at DESC LIMIT ?
      `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => ({
        ...row, cloud: Boolean(row.cloud), task: parseJson(row.taskJson, {}), reasons: parseJson(row.reasonsJson, []),
        considered: parseJson(row.consideredJson, []), taskJson: undefined, reasonsJson: undefined, consideredJson: undefined
      }));
    },
    // What a turn used, as the provider reported it. Ignored when nothing came
    // back: a turn whose usage never arrived is a gap in the record, and a
    // guessed row would be worse than an honest absence.
    recordTokenUsage(entry = {}) {
      const tokens = {
        input: Math.max(0, Math.round(Number(entry.inputTokens) || 0)),
        cached: Math.max(0, Math.round(Number(entry.cachedInputTokens) || 0)),
        output: Math.max(0, Math.round(Number(entry.outputTokens) || 0)),
        reasoning: Math.max(0, Math.round(Number(entry.reasoningTokens) || 0))
      };
      if (!tokens.input && !tokens.output) return null;
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO token_usage(id, conversation_id, message_id, provider_id, model_id,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, estimated_micros, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, entry.conversationId || null, entry.messageId || null,
        String(entry.providerId || ""), String(entry.modelId || ""),
        tokens.input, tokens.cached, tokens.output, tokens.reasoning,
        Number.isFinite(entry.estimatedMicros) ? Math.round(entry.estimatedMicros) : null, now());
      return id;
    },
    // Totals for one conversation, and for a calendar month. `unpriced` counts
    // the turns whose model had no published rate, so the interface can say the
    // estimate is incomplete rather than quietly under-reporting.
    tokenSpend({ conversationId = null, month = null } = {}) {
      const where = [];
      const params = [];
      if (conversationId) { where.push("conversation_id = ?"); params.push(conversationId); }
      if (month) { where.push("created_at LIKE ?"); params.push(`${month}%`); }
      const row = db.prepare(`
        SELECT COUNT(*) AS turns,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
          COALESCE(SUM(estimated_micros), 0) AS estimatedMicros,
          COALESCE(SUM(CASE WHEN estimated_micros IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
        FROM token_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      `).get(...params);
      return { ...row, totalTokens: row.inputTokens + row.outputTokens };
    },
    // Where the month went, biggest first. The question after "what did it
    // cost" is always "on what".
    tokenSpendByModel(month = null) {
      return db.prepare(`
        SELECT provider_id AS providerId, model_id AS modelId, COUNT(*) AS turns,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(estimated_micros), 0) AS estimatedMicros,
          COALESCE(SUM(CASE WHEN estimated_micros IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
        FROM token_usage ${month ? "WHERE created_at LIKE ?" : ""}
        GROUP BY provider_id, model_id ORDER BY estimatedMicros DESC, turns DESC LIMIT 20
      `).all(...(month ? [`${month}%`] : []));
    },
    addEvaluationCase(item) {
      const existing = item.feedbackId ? db.prepare("SELECT id FROM evaluation_cases WHERE feedback_id = ?").get(item.feedbackId) : null;
      if (existing) return api.getEvaluationCase(existing.id);
      const id = item.id || crypto.randomUUID();
      db.prepare(`
        INSERT INTO evaluation_cases(id, feedback_id, conversation_id, message_id, input, expected_qualities,
          failure_reason, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.feedbackId || null, item.conversationId || null, item.messageId || null,
        String(item.input || "").slice(0, 10_000), String(item.expectedQualities || "").slice(0, 2000),
        String(item.failureReason || "").slice(0, 2000), JSON.stringify(item.context || {}), item.createdAt || now());
      return api.getEvaluationCase(id);
    },
    getEvaluationCase(id) {
      const row = db.prepare(`SELECT id, feedback_id AS feedbackId, conversation_id AS conversationId,
        message_id AS messageId, input, expected_qualities AS expectedQualities, failure_reason AS failureReason,
        context_json AS contextJson, created_at AS createdAt FROM evaluation_cases WHERE id = ?`).get(id);
      return row ? { ...row, context: parseJson(row.contextJson, {}), contextJson: undefined } : null;
    },
    listEvaluationCases(limit = 100) {
      return db.prepare("SELECT id FROM evaluation_cases ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => api.getEvaluationCase(row.id));
    },
    createEvaluationRun(item) {
      const id = item.id || crypto.randomUUID();
      db.prepare(`INSERT INTO evaluation_runs(id, proposal_id, provider_id, model_id, status, summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, '{}', ?)`)
        .run(id, item.proposalId || null, item.providerId, item.modelId, item.status || "running", item.createdAt || now());
      return id;
    },
    addEvaluationCandidate(item) {
      const id = item.id || crypto.randomUUID();
      db.prepare(`INSERT INTO evaluation_candidates(id, run_id, case_id, candidate, metrics_json,
        critical_regression, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, item.runId, item.caseId, item.candidate || "comparison", JSON.stringify(item.metrics || {}),
          item.criticalRegression ? 1 : 0, String(item.explanation || "").slice(0, 2000), now());
      return id;
    },
    finishEvaluationRun(id, status, summary = {}) {
      db.prepare("UPDATE evaluation_runs SET status = ?, summary_json = ?, completed_at = ? WHERE id = ?")
        .run(status, JSON.stringify(summary), now(), id);
      return api.getEvaluationRun(id);
    },
    getEvaluationRun(id) {
      const run = db.prepare(`SELECT id, proposal_id AS proposalId, provider_id AS providerId, model_id AS modelId,
        status, summary_json AS summaryJson, created_at AS createdAt, completed_at AS completedAt
        FROM evaluation_runs WHERE id = ?`).get(id);
      if (!run) return null;
      run.summary = parseJson(run.summaryJson, {});
      delete run.summaryJson;
      run.results = db.prepare(`SELECT id, case_id AS caseId, candidate, metrics_json AS metricsJson,
        critical_regression AS criticalRegression, explanation, created_at AS createdAt
        FROM evaluation_candidates WHERE run_id = ? ORDER BY created_at`).all(id).map((row) => ({
        ...row, metrics: parseJson(row.metricsJson, {}), metricsJson: undefined, criticalRegression: Boolean(row.criticalRegression)
      }));
      return run;
    },
    listEvaluationRuns(limit = 30) {
      return db.prepare("SELECT id FROM evaluation_runs ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(100, Number(limit) || 30))).map((row) => api.getEvaluationRun(row.id));
    },
    addMemoryProposal(item) {
      const id = item.id || crypto.randomUUID();
      db.prepare(`INSERT INTO memory_proposals(id, conversation_id, source_message_id, action, target_id, type,
        title, body, links_json, rationale, confidence, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, item.conversationId || null, item.sourceMessageId || null, item.action, item.targetId || null,
          item.type, String(item.title).slice(0, 200), String(item.body || "").slice(0, 10_000),
          JSON.stringify(item.links || []), String(item.rationale || "").slice(0, 1000),
          Math.max(0, Math.min(1, Number(item.confidence) || 0.5)), item.createdAt || now());
      return api.getMemoryProposal(id);
    },
    getMemoryProposal(id) {
      const row = db.prepare(`SELECT id, conversation_id AS conversationId, source_message_id AS sourceMessageId,
        action, target_id AS targetId, type, title, body, links_json AS linksJson, rationale, confidence, status,
        created_at AS createdAt, reviewed_at AS reviewedAt FROM memory_proposals WHERE id = ?`).get(id);
      return row ? { ...row, links: parseJson(row.linksJson, []), linksJson: undefined } : null;
    },
    listMemoryProposals({ status = "pending", limit = 100 } = {}) {
      const rows = status
        ? db.prepare("SELECT id FROM memory_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, Math.max(1, Math.min(500, Number(limit) || 100)))
        : db.prepare("SELECT id FROM memory_proposals ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(limit) || 100)));
      return rows.map((row) => api.getMemoryProposal(row.id));
    },
    updateMemoryProposal(id, patch = {}) {
      const current = api.getMemoryProposal(id);
      if (!current || current.status !== "pending") return null;
      db.prepare(`UPDATE memory_proposals SET type = ?, title = ?, body = ?, links_json = ?, rationale = ? WHERE id = ?`)
        .run(patch.type || current.type, String(patch.title ?? current.title).slice(0, 200),
          String(patch.body ?? current.body).slice(0, 10_000), JSON.stringify(patch.links ?? current.links),
          String(patch.rationale ?? current.rationale).slice(0, 1000), id);
      return api.getMemoryProposal(id);
    },
    reviewMemoryProposal(id, decision, patch = {}) {
      const proposal = api.updateMemoryProposal(id, patch) || api.getMemoryProposal(id);
      if (!proposal || proposal.status !== "pending") return null;
      let approvedNode = null;
      if (decision === "approved") {
        db.transaction(() => {
          let node;
          if (proposal.action === "create") node = api.addMemoryNode({
            type: proposal.type, title: proposal.title, body: proposal.body, status: "active",
            source: "approved-intelligence", conversationId: proposal.conversationId
          });
          else {
            const target = api.getMemoryNode(proposal.targetId);
            if (!target) throw Object.assign(new Error("The target memory no longer exists."), { status: 409 });
            const status = proposal.action === "retire" ? (target.type === "task" ? "resolved" : "archived") : "active";
            node = api.updateMemoryNode(target.id, {
              type: proposal.type, title: proposal.title, body: proposal.body, status,
              embedding: null, embeddingModel: "", embeddingStatus: "lexical"
            });
          }
          if (node && proposal.action !== "retire") {
            const nodes = api.listMemoryNodes();
            for (const title of proposal.links) {
              const linked = nodes.find((item) => item.id !== node.id && item.title.toLowerCase() === title.toLowerCase());
              if (linked) api.addMemoryEdge({ fromId: node.id, toId: linked.id });
            }
          }
          approvedNode = node || null;
          db.prepare("UPDATE memory_proposals SET status = 'approved', reviewed_at = ? WHERE id = ?").run(now(), id);
        })();
      } else if (decision === "rejected") {
        db.prepare("UPDATE memory_proposals SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(now(), id);
      } else throw Object.assign(new Error("Decision must be approved or rejected."), { status: 400 });
      const reviewed = api.getMemoryProposal(id);
      return approvedNode ? { ...reviewed, memoryNode: approvedNode } : reviewed;
    },
    createIntelligenceUpgrade(item) {
      const id = item.id || crypto.randomUUID();
      db.prepare(`INSERT INTO intelligence_upgrades(id, kind, status, payload_json, previous_json,
        evaluation_run_id, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)`)
        .run(id, item.kind, JSON.stringify(item.payload || {}), JSON.stringify(item.previous || {}), item.evaluationRunId || null, now());
      return api.getIntelligenceUpgrade(id);
    },
    getIntelligenceUpgrade(id) {
      const row = db.prepare(`SELECT id, kind, status, payload_json AS payloadJson, previous_json AS previousJson,
        evaluation_run_id AS evaluationRunId, created_at AS createdAt, reviewed_at AS reviewedAt
        FROM intelligence_upgrades WHERE id = ?`).get(id);
      return row ? { ...row, payload: parseJson(row.payloadJson, {}), previous: parseJson(row.previousJson, {}), payloadJson: undefined, previousJson: undefined } : null;
    },
    listIntelligenceUpgrades(limit = 50) {
      return db.prepare("SELECT id FROM intelligence_upgrades ORDER BY created_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(100, Number(limit) || 50))).map((row) => api.getIntelligenceUpgrade(row.id));
    },
    reviewIntelligenceUpgrade(id, status) {
      if (!["approved", "rejected", "rolled-back"].includes(status)) throw Object.assign(new Error("Invalid upgrade decision."), { status: 400 });
      db.prepare("UPDATE intelligence_upgrades SET status = ?, reviewed_at = ? WHERE id = ?").run(status, now(), id);
      return api.getIntelligenceUpgrade(id);
    },
    listToolMacros() {
      return db.prepare(`
        SELECT id, name, title, description, steps_json AS stepsJson, inputs_json AS inputsJson,
               status, evidence_json AS evidenceJson, enabled, created_at AS createdAt, updated_at AS updatedAt
        FROM tool_macros ORDER BY created_at
      `).all().map((row) => ({
        ...row,
        steps: parseJson(row.stepsJson, []),
        inputs: parseJson(row.inputsJson, []),
        evidence: parseJson(row.evidenceJson, {}),
        enabled: Boolean(row.enabled),
        stepsJson: undefined,
        inputsJson: undefined,
        evidenceJson: undefined
      }));
    },
    getToolMacroByName(name) {
      return api.listToolMacros().find((macro) => macro.name === name) || null;
    },
    saveToolMacro({ id = crypto.randomUUID(), name, title, description = "", steps, inputs = [], status = "approved", evidence = {} }) {
      try {
        db.prepare(`
          INSERT INTO tool_macros(id, name, title, description, steps_json, inputs_json, status, evidence_json, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(id, name, title.slice(0, 200), description.slice(0, 2000), JSON.stringify(steps), JSON.stringify(inputs), status, JSON.stringify(evidence), now(), now());
      } catch (error) {
        if (String(error.code || "").startsWith("SQLITE_CONSTRAINT")) {
          throw Object.assign(new Error("A macro with that name already exists."), { status: 409 });
        }
        throw error;
      }
      return api.listToolMacros().find((macro) => macro.id === id);
    },
    updateToolMacro(id, patch = {}) {
      const current = db.prepare("SELECT * FROM tool_macros WHERE id = ?").get(id);
      if (!current) return null;
      db.prepare(`
        UPDATE tool_macros SET title = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?
      `).run(
        (patch.title ?? current.title).slice(0, 200),
        (patch.description ?? current.description).slice(0, 2000),
        patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
        now(),
        id
      );
      return api.listToolMacros().find((macro) => macro.id === id);
    },
    deleteToolMacro(id) {
      return db.prepare("DELETE FROM tool_macros WHERE id = ?").run(id).changes > 0;
    },
    audit(eventType, summary, { entityType = null, entityId = null, metadata = {} } = {}) {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO audit_events(id, event_type, entity_type, entity_id, summary, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), eventType, entityType, entityId, summary.slice(0, 1000), JSON.stringify(metadata), now());
        db.prepare(`
          DELETE FROM audit_events
          WHERE rowid IN (
            SELECT rowid FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5000
          )
        `).run();
      })();
    },
    getAuthCredential() {
      const row = db.prepare(`
        SELECT password_hash AS passwordHash, password_salt AS passwordSalt,
               scrypt_n AS scryptN, scrypt_r AS scryptR, scrypt_p AS scryptP,
               key_length AS keyLength, recovery_hash AS recoveryHash,
               created_at AS createdAt, updated_at AS updatedAt
        FROM auth_credentials WHERE id = 1
      `).get();
      return row || null;
    },
    createAuthCredential(credential) {
      const timestamp = now();
      try {
        db.prepare(`
          INSERT INTO auth_credentials
            (id, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, key_length,
             recovery_hash, created_at, updated_at)
          VALUES (1, @passwordHash, @passwordSalt, @scryptN, @scryptR, @scryptP,
                  @keyLength, @recoveryHash, @createdAt, @updatedAt)
        `).run({ ...credential, createdAt: timestamp, updatedAt: timestamp });
        return api.getAuthCredential();
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          throw Object.assign(new Error("Evolv authentication is already configured."), { status: 409 });
        }
        throw error;
      }
    },
    updateAuthCredential(credential) {
      const result = db.prepare(`
        UPDATE auth_credentials
        SET password_hash = @passwordHash, password_salt = @passwordSalt,
            scrypt_n = @scryptN, scrypt_r = @scryptR, scrypt_p = @scryptP,
            key_length = @keyLength, recovery_hash = @recoveryHash, updated_at = @updatedAt
        WHERE id = 1
      `).run({ ...credential, updatedAt: now() });
      if (!result.changes) throw Object.assign(new Error("Evolv authentication is not configured."), { status: 409 });
      return api.getAuthCredential();
    },
    listProviderCredentials() {
      return db.prepare(`
        SELECT provider_id AS providerId, encrypted_secret AS encryptedSecret,
               base_url AS baseUrl, capabilities_json AS capabilitiesJson,
               status, status_message AS statusMessage, updated_at AS updatedAt,
               tested_at AS testedAt
        FROM provider_credentials ORDER BY provider_id
      `).all().map((row) => ({
        ...row,
        capabilities: parseJson(row.capabilitiesJson, {}),
        capabilitiesJson: undefined
      }));
    },
    getProviderCredential(providerId) {
      return api.listProviderCredentials().find((item) => item.providerId === providerId) || null;
    },
    saveProviderCredential({ providerId, encryptedSecret = "", baseUrl = "", capabilities = {} }) {
      db.prepare(`
        INSERT INTO provider_credentials
          (provider_id, encrypted_secret, base_url, capabilities_json, status, status_message, updated_at)
        VALUES (?, ?, ?, ?, 'configured', '', ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          encrypted_secret = excluded.encrypted_secret,
          base_url = excluded.base_url,
          capabilities_json = excluded.capabilities_json,
          status = 'configured', status_message = '', updated_at = excluded.updated_at
      `).run(providerId, encryptedSecret, baseUrl, JSON.stringify(capabilities), now());
      return api.getProviderCredential(providerId);
    },
    setProviderStatus(providerId, status, statusMessage = "") {
      db.prepare(`
        UPDATE provider_credentials
        SET status = ?, status_message = ?, tested_at = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(status, String(statusMessage).slice(0, 500), now(), now(), providerId);
      return api.getProviderCredential(providerId);
    },
    deleteProviderCredential(providerId) {
      return db.prepare("DELETE FROM provider_credentials WHERE provider_id = ?").run(providerId).changes > 0;
    },
    getMigrationStatus() {
      return {
        schemaVersion: SCHEMA_VERSION,
        legacyStateImported: Boolean(db.prepare("SELECT 1 FROM migration_receipts WHERE source = 'state.json'").get()),
        browserImported: Boolean(db.prepare("SELECT 1 FROM migration_receipts WHERE source = 'browser-v1'").get())
      };
    },
    importBrowser(payload) {
      const fingerprint = String(payload.fingerprint || "");
      if (!fingerprint) throw Object.assign(new Error("Migration fingerprint is required."), { status: 400 });
      const existing = db.prepare("SELECT counts_json FROM migration_receipts WHERE fingerprint = ?").get(fingerprint);
      if (existing) return { imported: false, counts: parseJson(existing.counts_json, {}) };
      const conversations = Array.isArray(payload.conversations) ? payload.conversations.slice(0, 5000) : [];
      const current = Array.isArray(payload.current) && payload.current.length ? [{ messages: payload.current }] : [];
      const insertConversation = db.prepare("INSERT OR IGNORE INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)");
      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO messages(id, conversation_id, role, content, thinking, model, mode, status, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', '{}', ?, ?)
      `);
      const counts = { conversations: 0, messages: 0, settings: 0 };
      db.transaction(() => {
        for (const [conversationIndex, item] of [...conversations, ...current].entries()) {
          const conversationId = item.id || crypto.createHash("sha256").update(`${fingerprint}:${conversationIndex}`).digest("hex").slice(0, 32);
          const createdAt = item.createdAt || now();
          const messages = Array.isArray(item.messages) ? item.messages : [];
          const title = item.title || messages.find((message) => message.role === "user")?.content?.slice(0, 60) || "Imported conversation";
          counts.conversations += insertConversation.run(conversationId, title, createdAt, createdAt).changes;
          for (const [messageIndex, message] of messages.entries()) {
            if (!["user", "assistant"].includes(message?.role) || typeof message.content !== "string") continue;
            const messageId = crypto.createHash("sha256").update(`${conversationId}:${messageIndex}`).digest("hex").slice(0, 32);
            counts.messages += insertMessage.run(
              messageId,
              conversationId,
              message.role,
              message.content,
              message.thinking || "",
              message.model || null,
              message.mode || null,
              createdAt,
              createdAt
            ).changes;
          }
        }
        if (payload.settings && typeof payload.settings === "object") {
          api.patchSettings(Object.fromEntries(Object.entries(payload.settings).filter(([key]) =>
            ["provider", "model", "think", "temperature", "numCtx", "mode"].includes(key)
          )));
          counts.settings = Object.keys(payload.settings).length;
        }
        db.prepare(`
          INSERT INTO migration_receipts(id, source, fingerprint, counts_json, created_at) VALUES (?, 'browser-v1', ?, ?, ?)
        `).run(crypto.randomUUID(), fingerprint, JSON.stringify(counts), now());
      })();
      return { imported: true, counts };
    },
    // Every conversation id (active, archived, and trashed), unbounded — the
    // paginated listConversations() caps at 100 and must not be used for export.
    allConversationIds() {
      return db.prepare("SELECT id FROM conversations ORDER BY updated_at DESC").all().map((row) => row.id);
    },
    exportData() {
      const state = api.getState();
      state.knowledge = state.knowledge.map(({ embedding, ...item }) => item);
      const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const liveVaultConnected = hasTable("vault_connection")
        && Boolean(db.prepare("SELECT 1 FROM vault_connection WHERE id=1").get());
      const toolRecipes = hasTable("tool_recipe_proposals") ? {
        proposals: db.prepare(`SELECT id,request,provider_id AS providerId,model_id AS modelId,
          definition_json AS definitionJson,validation_json AS validationJson,status,created_at AS createdAt,
          reviewed_at AS reviewedAt FROM tool_recipe_proposals ORDER BY created_at`).all().map((row) => ({
          ...row,
          definition: parseJson(row.definitionJson, {}),
          validation: parseJson(row.validationJson, {}),
          definitionJson: undefined,
          validationJson: undefined
        })),
        versions: db.prepare(`SELECT v.id,m.name AS macroName,v.version,v.definition_json AS definitionJson,
          v.definition_hash AS hash,v.active,v.created_at AS createdAt
          FROM tool_recipe_versions v JOIN tool_macros m ON m.id=v.macro_id ORDER BY m.name,v.version`).all().map((row) => ({
          ...row, definition: parseJson(row.definitionJson, {}), active: Boolean(row.active), definitionJson: undefined
        }))
      } : { proposals: [], versions: [] };
      const projects = hasTable("projects") ? {
        items: db.prepare(`SELECT id,name,description,status,created_at AS createdAt,updated_at AS updatedAt FROM projects ORDER BY created_at`).all(),
        tasks: db.prepare(`SELECT id,project_id AS projectId,title,description,status,priority,created_at AS createdAt,updated_at AS updatedAt FROM project_tasks ORDER BY created_at`).all(),
        memory: db.prepare(`SELECT project_id AS projectId,memory_id AS memoryId,scope,created_at AS createdAt FROM project_memory ORDER BY created_at`).all(),
        sources: db.prepare(`SELECT id,project_id AS projectId,title,kind,status,source_path AS sourcePath,content_hash AS contentHash,error,
          created_at AS createdAt,updated_at AS updatedAt FROM project_knowledge_sources WHERE status!='deleted' ORDER BY created_at`).all(),
        chunks: db.prepare(`SELECT c.id,c.source_id AS sourceId,c.position,c.locator,c.content,c.content_hash AS contentHash,c.created_at AS createdAt
          FROM project_knowledge_chunks c JOIN project_knowledge_sources s ON s.id=c.source_id WHERE s.status!='deleted' ORDER BY c.source_id,c.position`).all()
      } : { items: [], tasks: [], memory: [], sources: [], chunks: [] };
      return {
        format: "evolv-export",
        version: 1,
        exportedAt: now(),
        settings: api.getSettings(),
        state,
        conversations: api.allConversationIds().map((id) => api.getConversation(id)),
        // A connected Obsidian vault is intentionally a separate portable
        // asset. Do not copy its path or authoritative note contents here.
        memory: liveVaultConnected ? { nodes: [], edges: [] } : api.getMemoryGraph(),
        toolMacros: api.listToolMacros(),
        toolRecipes,
        // Folder grants and artifact storage paths are intentionally excluded.
        // Imported projects must reconnect folders; indexed text remains portable.
        projects,
        intelligence: {
          modelPreferences: api.listModelPreferences(),
          routing: api.listRoutingEvents(500),
          evaluationCases: api.listEvaluationCases(500),
          evaluationRuns: api.listEvaluationRuns(100),
          memoryProposals: api.listMemoryProposals({ status: "", limit: 500 }),
          upgrades: api.listIntelligenceUpgrades(100)
        }
      };
    },
    importData(payload) {
      if (payload?.format !== "evolv-export" || payload.version !== 1) {
        throw Object.assign(new Error("Unsupported Evolv export."), { status: 400 });
      }
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const conversationResult = api.importBrowser({
        fingerprint: `export:${fingerprint}`,
        conversations: payload.conversations || [],
        settings: payload.settings || {}
      });
      const current = api.getState();
      const imported = payload.state || {};
      const mergeById = (left, right) => {
        const seen = new Set(left.map((item) => item.id));
        return [...left, ...(right || []).filter((item) => item?.id && !seen.has(item.id))];
      };
      api.saveState({
        ...current,
        versions: mergeById(current.versions, imported.versions),
        feedback: mergeById(current.feedback, imported.feedback),
        knowledge: mergeById(current.knowledge, imported.knowledge),
        architectureProposals: mergeById(current.architectureProposals, imported.architectureProposals),
        settings: { ...current.settings, ...(payload.settings || {}) }
      });
      const existingNodeIds = new Set(api.listMemoryNodes().map((node) => node.id));
      for (const node of payload.memory?.nodes || []) {
        if (!node?.id || existingNodeIds.has(node.id)) continue;
        try {
          api.addMemoryNode({ ...node, conversationId: null, embedding: null, embeddingModel: "", embeddingStatus: "lexical" });
          existingNodeIds.add(node.id);
        } catch { /* skip records that fail type/status constraints */ }
      }
      const edgeKeys = new Set(api.listMemoryEdges().map((edge) => `${edge.fromId}:${edge.toId}:${edge.relation}`));
      for (const edge of payload.memory?.edges || []) {
        if (!edge?.fromId || !edge?.toId) continue;
        if (!existingNodeIds.has(edge.fromId) || !existingNodeIds.has(edge.toId)) continue;
        if (edgeKeys.has(`${edge.fromId}:${edge.toId}:${edge.relation}`)) continue;
        api.addMemoryEdge(edge);
      }
      const importedProjectIds = new Set();
      for (const project of payload.projects?.items || []) {
        if (!project?.id || db.prepare("SELECT 1 FROM projects WHERE id=?").get(project.id)) continue;
        try {
          db.prepare("INSERT INTO projects(id,name,description,status,is_default,created_at,updated_at) VALUES (?,?,?,?,0,?,?)").run(
            project.id, String(project.name || "Imported project").slice(0, 120), String(project.description || "").slice(0, 2000),
            ["active", "archived"].includes(project.status) ? project.status : "active", project.createdAt || now(), project.updatedAt || now()
          );
          importedProjectIds.add(project.id);
        } catch {}
      }
      for (const task of payload.projects?.tasks || []) {
        if (!importedProjectIds.has(task?.projectId) || !task?.id) continue;
        try {
          db.prepare(`INSERT OR IGNORE INTO project_tasks(id,project_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
            task.id, task.projectId, String(task.title || "Imported task").slice(0, 120), String(task.description || "").slice(0, 5000),
            ["open", "in-progress", "blocked", "done", "archived"].includes(task.status) ? task.status : "open",
            Math.max(1, Math.min(5, Number(task.priority) || 3)), task.createdAt || now(), task.updatedAt || now()
          );
        } catch {}
      }
      const importedSourceIds = new Set();
      for (const source of payload.projects?.sources || []) {
        if (!importedProjectIds.has(source?.projectId) || !source?.id) continue;
        try {
          db.prepare(`INSERT OR IGNORE INTO project_knowledge_sources(id,project_id,artifact_id,title,kind,status,source_path,content_hash,error,created_at,updated_at)
            VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`).run(source.id, source.projectId, String(source.title || "Imported source").slice(0, 200),
            String(source.kind || "text").slice(0, 40), ["indexed", "metadata-only", "failed"].includes(source.status) ? source.status : "indexed",
            String(source.sourcePath || "").slice(0, 500), String(source.contentHash || "").slice(0, 64), String(source.error || "").slice(0, 1000),
            source.createdAt || now(), source.updatedAt || now());
          importedSourceIds.add(source.id);
        } catch {}
      }
      for (const chunk of payload.projects?.chunks || []) {
        if (!importedSourceIds.has(chunk?.sourceId) || !chunk?.id || typeof chunk.content !== "string") continue;
        try {
          db.prepare(`INSERT OR IGNORE INTO project_knowledge_chunks(id,source_id,position,locator,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?)`).run(
            chunk.id, chunk.sourceId, Math.max(0, Number(chunk.position) || 0), String(chunk.locator || "Imported").slice(0, 300),
            chunk.content.slice(0, 8000), String(chunk.contentHash || "").slice(0, 64), chunk.createdAt || now());
        } catch {}
      }
      for (const link of payload.projects?.memory || []) {
        if (!importedProjectIds.has(link?.projectId) || !existingNodeIds.has(link?.memoryId)) continue;
        try {
          db.prepare("INSERT OR IGNORE INTO project_memory(project_id,memory_id,scope,created_at) VALUES (?,?,?,?)").run(
            link.projectId, link.memoryId, ["working", "project", "long-term", "strategy", "failure"].includes(link.scope) ? link.scope : "project", link.createdAt || now()
          );
        } catch {}
      }
      const existingMacroNames = new Set(api.listToolMacros().map((macro) => macro.name));
      const importedMacroNames = new Set();
      for (const macro of payload.toolMacros || []) {
        if (!macro?.name || existingMacroNames.has(macro.name)) continue;
        try {
          api.saveToolMacro(macro);
          existingMacroNames.add(macro.name);
          importedMacroNames.add(macro.name);
        } catch { /* skip macros that fail constraints */ }
      }
      const hasRecipeTables = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_recipe_versions'").get());
      if (hasRecipeTables) {
        for (const version of payload.toolRecipes?.versions || []) {
          const macro = api.getToolMacroByName(version.macroName);
          if (!macro || !importedMacroNames.has(version.macroName) || !version.definition || !Number.isInteger(version.version)) continue;
          try {
            db.prepare(`INSERT OR IGNORE INTO tool_recipe_versions(id,macro_id,version,definition_json,definition_hash,active,created_at)
              VALUES (?,?,?,?,?,?,?)`).run(
              version.id || crypto.randomUUID(), macro.id, version.version, JSON.stringify(version.definition),
              version.hash || crypto.createHash("sha256").update(JSON.stringify(version.definition)).digest("hex"),
              version.active ? 1 : 0, version.createdAt || now()
            );
          } catch {}
        }
        // Pending generated proposals are deliberately not imported: they
        // have not been approved on either installation and must be generated
        // and validated again against the destination's enabled tool catalog.
      }
      for (const preference of payload.intelligence?.modelPreferences || []) {
        if (!preference?.providerId || !preference?.modelId) continue;
        try { api.saveModelPreference(preference.providerId, preference.modelId, preference); } catch {}
      }
      for (const evaluationCase of payload.intelligence?.evaluationCases || []) {
        if (!evaluationCase?.input) continue;
        try { api.addEvaluationCase({ ...evaluationCase, conversationId: null, messageId: null }); } catch {}
      }
      for (const proposal of payload.intelligence?.memoryProposals || []) {
        if (proposal?.status !== "pending" || !proposal.title || !proposal.body) continue;
        try { api.addMemoryProposal({ ...proposal, conversationId: null, sourceMessageId: null }); } catch {}
      }
      return {
        ...conversationResult,
        counts: {
          ...conversationResult.counts,
          versions: imported.versions?.length || 0,
          feedback: imported.feedback?.length || 0,
          knowledge: imported.knowledge?.length || 0,
          architectureProposals: imported.architectureProposals?.length || 0
        }
      };
    },
    async backup(reason = "manual") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const destination = path.join(backupsDir, `evolv-${stamp}-${reason}.db`);
      await db.backup(destination);
      const files = fs.readdirSync(backupsDir)
        .filter((name) => /^evolv-.*\.db$/.test(name))
        .map((name) => ({ name, path: path.join(backupsDir, name), mtime: fs.statSync(path.join(backupsDir, name)).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const stale of files.slice(10)) fs.unlinkSync(stale.path);
      api.setMeta("last_backup_at", now());
      api.audit("backup.created", `Created ${reason} backup`, { metadata: { file: path.basename(destination) } });
      return { file: path.basename(destination), createdAt: now() };
    },
    maybeDailyBackup() {
      const last = Date.parse(api.getMeta("last_backup_at", "0"));
      if (!Number.isFinite(last) || Date.now() - last > 86_400_000) {
        return api.backup("daily");
      }
      return Promise.resolve(null);
    }
  };

  function importLegacyState() {
    if (!legacyStateFile || !fs.existsSync(legacyStateFile)) return;
    if (db.prepare("SELECT 1 FROM migration_receipts WHERE source = 'state.json'").get()) return;
    const raw = fs.readFileSync(legacyStateFile, "utf8");
    const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
    const backupName = `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.copyFileSync(legacyStateFile, path.join(backupsDir, backupName));
    const parsed = JSON.parse(raw);
    api.saveState(parsed);
    const counts = {
      versions: parsed.versions?.length || 0,
      feedback: parsed.feedback?.length || 0,
      knowledge: parsed.knowledge?.length || 0,
      architectureProposals: parsed.architectureProposals?.length || 0
    };
    db.prepare(`
      INSERT INTO migration_receipts(id, source, fingerprint, counts_json, created_at) VALUES (?, 'state.json', ?, ?, ?)
    `).run(crypto.randomUUID(), fingerprint, JSON.stringify(counts), now());
    api.audit("migration.completed", "Imported legacy state.json", { metadata: { counts, backupName } });
  }

  importLegacyState();
  return api;
}
