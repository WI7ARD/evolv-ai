import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { extractWikilinks, parseVaultMarkdown, vaultFilename } from "./obsidian.mjs";
import { lexicalSimilarity, cosineSimilarity } from "./memory.mjs";
import { canonicalRootSync } from "./canonical-path.mjs";

const MAX_MARKDOWN = 512 * 1024;
const MAX_CANVAS = 2 * 1024 * 1024;
const MAX_FILES = 10_000;
const EMBEDDING_MODEL = "nomic-embed-text:latest";
const MEMORY_TYPES = new Set(["project", "task", "decision", "preference", "note"]);
const MEMORY_STATUSES = new Set(["active", "proposed", "resolved", "archived"]);
const IGNORED_SEGMENTS = new Set([".obsidian", ".trash", "evolv backups"]);

function now() {
  return new Date().toISOString();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  return Buffer.from(new Float32Array(vector).buffer);
}

function decodeVector(buffer) {
  if (!buffer) return null;
  const value = Buffer.from(buffer);
  return Array.from(new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4));
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizedRelative(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function titleFromPath(relative) {
  return path.basename(relative).replace(/\.(?:md|canvas)$/i, "").slice(0, 200) || "Untitled";
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (pair) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { raw: match?.[1] || "", fields, body: match ? text.slice(match[0].length) : text };
}

function markdownChunks(body) {
  const lines = String(body || "").split(/\r?\n/);
  const chunks = [];
  let heading = "Note";
  let buffer = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (!text) return;
    for (let start = 0; start < text.length; start += 4_000) {
      chunks.push({ heading, text: text.slice(start, start + 4_400) });
    }
    buffer = [];
  };
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      flush();
      heading = match[1].trim().slice(0, 200);
    } else buffer.push(line);
  }
  flush();
  return chunks.length ? chunks : [{ heading: "Note", text: String(body || "").slice(0, 4_400) }];
}

function parseCanvas(relativePath, content) {
  const parsed = JSON.parse(content);
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const nodeTargets = new Map(nodes.map((node) => [
    String(node?.id || ""),
    typeof node?.file === "string"
      ? node.file.replace(/\.md$/i, "")
      : typeof node?.text === "string"
        ? node.text.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").slice(0, 200)
        : ""
  ]));
  const textNodes = nodes.flatMap((node) => {
    if (typeof node?.text === "string") return [{ id: String(node.id || ""), text: node.text }];
    if (typeof node?.file === "string") return [{ id: String(node.id || ""), text: `Linked note: [[${node.file.replace(/\.md$/i, "")}]]` }];
    return [];
  });
  return {
    title: titleFromPath(relativePath),
    type: "note",
    status: "active",
    body: textNodes.map((node) => node.text).join("\n\n").slice(0, 100_000),
    links: textNodes.flatMap((node) => extractWikilinks(node.text)),
    tags: [],
    frontmatter: {},
    canvasEdges: edges.slice(0, 5_000).map((edge) => ({
      from: nodeTargets.get(String(edge.fromNode || "")) || "",
      to: nodeTargets.get(String(edge.toNode || "")) || "",
      label: String(edge.label || "canvas-edge").slice(0, 80)
    })).filter((edge) => edge.to)
  };
}

function parseMarkdown(relativePath, content) {
  const parsed = parseVaultMarkdown(relativePath, content);
  const frontmatter = parseFrontmatter(content);
  const tags = [...new Set([
    ...(String(frontmatter.fields.tags || "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter(Boolean)),
    ...[...frontmatter.body.matchAll(/(?:^|\s)#([A-Za-z0-9_/-]{2,80})/g)].map((match) => match[1])
  ])].slice(0, 100);
  return {
    ...parsed,
    title: String(frontmatter.fields.title || titleFromPath(relativePath)).replace(/^["']|["']$/g, "").slice(0, 200),
    id: /^[0-9a-f-]{16,64}$/i.test(frontmatter.fields.evolv_id || frontmatter.fields.id || "")
      ? (frontmatter.fields.evolv_id || frontmatter.fields.id) : "",
    tags,
    aliases: String(frontmatter.fields.aliases || frontmatter.fields.alias || "")
      .replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 50),
    frontmatter: frontmatter.fields,
    body: frontmatter.body.trim().slice(0, 100_000)
  };
}

export class ObsidianVaultService {
  constructor({ database, profileId, host = null, embedText = null, approvalService = null }) {
    this.database = database;
    this.profileId = profileId;
    this.host = host;
    this.embedText = embedText;
    this.approvalService = approvalService;
    this.watcher = null;
    this.syncTimer = null;
    this.periodicTimer = null;
    this.syncing = null;
    this.toolSpecHandler = null;
    this.projectTaskSyncHandler = null;
    this.closed = false;
    this.#migrateSchema();
    const connection = this.#connection();
    if (connection?.rootPath && fs.existsSync(connection.rootPath)) {
      try {
        this.host?.claimRoot(profileId, connection.rootPath);
        this.#startWatcher(connection.rootPath);
        queueMicrotask(() => {
          if (!this.closed) this.sync().catch((error) => {
            if (!this.closed) this.#setConnectionError(error.message);
          });
        });
      } catch (error) {
        this.#setConnectionError(error.message);
      }
    }
  }

  #migrateSchema() {
    // Tables come from the recorded schema in lib/schema.mjs.
    const noteColumns = new Set(this.database.raw.prepare("PRAGMA table_info(vault_notes)").all().map((column) => column.name));
    if (!noteColumns.has("aliases_json")) {
      this.database.raw.exec("ALTER TABLE vault_notes ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  #connection() {
    const row = this.database.raw.prepare(`SELECT root_path AS rootPath, label, status,
      last_sync_at AS lastSyncAt, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
      FROM vault_connection WHERE id = 1`).get();
    return row || null;
  }

  #setConnectionError(message) {
    this.database.raw.prepare("UPDATE vault_connection SET status = 'error', last_error = ?, updated_at = ? WHERE id = 1")
      .run(String(message || "").slice(0, 1000), now());
  }

  connected() {
    return Boolean(this.#connection()?.rootPath);
  }

  setToolSpecHandler(handler) {
    this.toolSpecHandler = typeof handler === "function" ? handler : null;
  }

  setProjectTaskSyncHandler(handler) {
    this.projectTaskSyncHandler = typeof handler === "function" ? handler : null;
  }

  status() {
    const connection = this.#connection();
    const stats = this.database.raw.prepare(`SELECT COUNT(*) AS notes,
      COALESCE(SUM(missing), 0) AS missing FROM vault_notes`).get();
    const chunks = this.database.raw.prepare("SELECT COUNT(*) AS count FROM vault_chunks").get().count;
    const links = this.database.raw.prepare("SELECT COUNT(*) AS count FROM vault_links").get().count;
    const pending = this.database.raw.prepare("SELECT COUNT(*) AS count FROM vault_changes WHERE status = 'pending'").get().count;
    const migration = this.database.raw.prepare("SELECT counts_json FROM migration_receipts WHERE source='obsidian-live-v1'").get();
    return {
      desktopAvailable: Boolean(this.host),
      connected: Boolean(connection),
      label: connection?.label || "",
      status: connection?.status || "disconnected",
      lastSyncAt: connection?.lastSyncAt || null,
      lastError: connection?.lastError || "",
      notes: stats.notes,
      chunks,
      links,
      missing: stats.missing,
      pendingChanges: pending,
      syncing: Boolean(this.syncing),
      migration: migration ? { complete: true, ...safeJson(migration.counts_json, {}) } : { complete: false }
    };
  }

  async connectGrant(grant) {
    if (!this.host) throw Object.assign(new Error("Live Obsidian connection is available only in the Evolv desktop app."), { status: 409 });
    const selected = this.host.consumeGrant(grant);
    const root = this.host.claimRoot(this.profileId, selected);
    const previous = this.#connection();
    if (previous?.rootPath && previous.rootPath !== root) this.host.releaseRoot(this.profileId, previous.rootPath);
    this.database.raw.prepare(`INSERT INTO vault_connection(id, root_path, label, status, last_error, created_at, updated_at)
      VALUES (1, ?, ?, 'connected', '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET root_path=excluded.root_path, label=excluded.label,
        status='connected', last_error='', updated_at=excluded.updated_at`)
      .run(root, path.basename(root) || "Evolv Vault", now(), now());
    await fsp.mkdir(path.join(root, "Memory"), { recursive: true });
    await fsp.mkdir(path.join(root, "Tools"), { recursive: true });
    await this.sync({ migrateExisting: true });
    this.#startWatcher(root);
    this.database.audit("obsidian.connected", "Connected dedicated Obsidian vault", { metadata: { label: path.basename(root) } });
    return this.status();
  }

  async disconnect() {
    const connection = this.#connection();
    this.#stopWatcher();
    if (connection?.rootPath) this.host?.releaseRoot(this.profileId, connection.rootPath);
    this.database.raw.prepare("DELETE FROM vault_connection WHERE id = 1").run();
    this.database.audit("obsidian.disconnected", "Disconnected Obsidian vault");
    return this.status();
  }

  #startWatcher(root) {
    this.#stopWatcher();
    try {
      // Watch the canonical directory. A recursive watch on a path the
      // filesystem spells differently aborts the process on Windows; see
      // lib/canonical-path.mjs.
      this.watcher = fs.watch(canonicalRootSync(root), { recursive: true }, () => {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.sync().catch((error) => this.#setConnectionError(error.message)), 750);
      });
      this.watcher.on("error", (error) => this.#setConnectionError(error.message));
    } catch (error) {
      this.#setConnectionError(`Live watcher unavailable: ${error.message}`);
    }
    this.periodicTimer = setInterval(() => this.sync().catch((error) => this.#setConnectionError(error.message)), 60_000);
    this.periodicTimer.unref?.();
  }

  #stopWatcher() {
    clearTimeout(this.syncTimer);
    clearInterval(this.periodicTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  async #files(root) {
    const output = [];
    const walk = async (directory, relative = "") => {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (output.length >= MAX_FILES) return;
        const childRelative = normalizedRelative(path.join(relative, entry.name));
        const segments = childRelative.toLowerCase().split("/");
        if (segments.some((segment) => segment.startsWith(".") || IGNORED_SEGMENTS.has(segment))) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute, childRelative);
        else if (/\.(?:md|canvas)$/i.test(entry.name)) output.push({ absolute, relative: childRelative });
      }
    };
    await walk(root);
    return output;
  }

  async sync({ migrateExisting = false } = {}) {
    if (this.closed) throw new Error("Obsidian vault service is closed.");
    if (this.syncing) return this.syncing;
    this.syncing = this.#sync({ migrateExisting }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async #sync({ migrateExisting }) {
    const connection = this.#connection();
    if (!connection) throw Object.assign(new Error("Connect an Obsidian vault first."), { status: 409 });
    const root = await fsp.realpath(connection.rootPath);
    if (migrateExisting) await this.#migrateExisting(root);
    const runId = crypto.randomUUID();
    this.database.raw.prepare("INSERT INTO vault_sync_runs(id,status,created_at) VALUES (?, 'running', ?)").run(runId, now());
    let scanned = 0;
    let changed = 0;
    try {
      const files = await this.#files(root);
      const fileSet = new Set(files.map((file) => file.relative.toLowerCase()));
      const seen = new Set();
      const changedChunks = [];
      const changedToolSpecs = [];
      const changedProjectTasks = [];
      for (const file of files) {
        const info = await fsp.stat(file.absolute);
        const limit = file.relative.toLowerCase().endsWith(".canvas") ? MAX_CANVAS : MAX_MARKDOWN;
        if (!info.isFile() || info.size > limit) continue;
        const real = await fsp.realpath(file.absolute);
        if (real !== root && !real.startsWith(`${root}${path.sep}`)) continue;
        const content = await fsp.readFile(real, "utf8");
        const contentHash = hash(content);
        const existingAtPath = this.database.raw.prepare("SELECT * FROM vault_notes WHERE relative_path = ?").get(file.relative);
        const record = file.relative.toLowerCase().endsWith(".canvas")
          ? parseCanvas(file.relative, content) : parseMarkdown(file.relative, content);
        const existingById = record.id
          ? this.database.raw.prepare("SELECT * FROM vault_notes WHERE id = ?").get(record.id)
          : null;
        // A stable evolv_id follows a note across a rename. If both the old
        // and new paths exist, treat the second file as a copy with a new ID.
        const renamed = existingById
          && existingById.relative_path.toLowerCase() !== file.relative.toLowerCase()
          && !fileSet.has(existingById.relative_path.toLowerCase())
          && !existingAtPath;
        if (renamed) {
          this.database.raw.prepare("UPDATE vault_notes SET relative_path=?,updated_at=? WHERE id=?")
            .run(file.relative, now(), existingById.id);
        }
        const existing = existingAtPath || (renamed ? existingById : null);
        const toolSpecification = file.relative.toLowerCase().startsWith("tools/");
        const id = existing?.id || (record.id && !existingById ? record.id : crypto.randomUUID());
        seen.add(file.relative.toLowerCase());
        scanned += 1;
        if (existing?.content_hash === contentHash && !existing.missing) continue;
        if (toolSpecification && existing && record.frontmatter?.source === "generated-tool-spec") {
          changedToolSpecs.push({ path: file.relative, content });
        }
        if (!toolSpecification && record.type === "task" && record.frontmatter?.project_id) {
          changedProjectTasks.push({
            path: file.relative,
            projectId: String(record.frontmatter.project_id).slice(0, 100),
            taskId: String(record.frontmatter.task_id || record.id || "").slice(0, 100),
            title: record.title,
            description: record.body,
            status: String(record.frontmatter.status || record.status || "open").toLowerCase(),
            priority: Number(record.frontmatter.priority) || undefined
          });
        }
        changed += 1;
        const stamp = now();
        this.database.raw.transaction(() => {
          this.database.raw.prepare(`INSERT INTO vault_notes(id,relative_path,title,type,status,format,body,
            frontmatter_json,tags_json,aliases_json,content_hash,mtime_ms,missing,source,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'obsidian',?,?)
            ON CONFLICT(relative_path) DO UPDATE SET title=excluded.title,type=excluded.type,status=excluded.status,
              format=excluded.format,body=excluded.body,frontmatter_json=excluded.frontmatter_json,
              tags_json=excluded.tags_json,aliases_json=excluded.aliases_json,content_hash=excluded.content_hash,mtime_ms=excluded.mtime_ms,
              missing=0,updated_at=excluded.updated_at`)
            .run(id, file.relative, record.title, MEMORY_TYPES.has(record.type) ? record.type : "note",
              MEMORY_STATUSES.has(record.status) ? record.status : "active", file.relative.endsWith(".canvas") ? "canvas" : "markdown",
              record.body, JSON.stringify(record.frontmatter || {}), JSON.stringify(record.tags || []), JSON.stringify(record.aliases || []),
              contentHash, Math.round(info.mtimeMs), stamp, stamp);
          const noteId = existing?.id || id;
          this.database.raw.prepare("DELETE FROM vault_chunks WHERE note_id = ?").run(noteId);
          this.database.raw.prepare("DELETE FROM vault_links WHERE from_note_id = ?").run(noteId);
          const chunks = toolSpecification ? [] : markdownChunks(record.body);
          chunks.forEach((chunk, ordinal) => {
            const chunkId = crypto.randomUUID();
            this.database.raw.prepare(`INSERT INTO vault_chunks(id,note_id,ordinal,heading,text) VALUES (?,?,?,?,?)`)
              .run(chunkId, noteId, ordinal, chunk.heading, chunk.text);
            changedChunks.push({ id: chunkId, text: `${record.title}\n${chunk.heading}\n${chunk.text}` });
          });
          const normalizedLinks = (record.links || extractWikilinks(record.body)).map((link) =>
            typeof link === "string" ? { title: link, relation: "relates-to" } : link
          ).filter((link) => link?.title);
          const linkKeys = new Set();
          for (const link of (toolSpecification ? [] : normalizedLinks.slice(0, 200))) {
            const title = String(link.title).slice(0, 200);
            const relation = String(link.relation || "relates-to").slice(0, 80);
            const key = `${title.toLowerCase()}:${relation.toLowerCase()}`;
            if (linkKeys.has(key)) continue;
            linkKeys.add(key);
            this.database.raw.prepare(`INSERT OR IGNORE INTO vault_links(id,from_note_id,target_title,relation) VALUES (?,?,?,?)`)
              .run(crypto.randomUUID(), noteId, title, relation);
          }
          for (const edge of (toolSpecification ? [] : record.canvasEdges || [])) {
            this.database.raw.prepare(`INSERT OR IGNORE INTO vault_links(id,from_note_id,target_title,relation) VALUES (?,?,?,?)`)
              .run(crypto.randomUUID(), noteId, edge.to.slice(0, 200), edge.label.slice(0, 80));
          }
        })();
      }
      const current = this.database.raw.prepare("SELECT id, relative_path AS relativePath FROM vault_notes WHERE missing = 0").all();
      const missing = current.filter((item) => !seen.has(item.relativePath.toLowerCase()));
      for (const item of missing) this.database.raw.prepare("UPDATE vault_notes SET missing=1,status='archived',updated_at=? WHERE id=?").run(now(), item.id);
      await this.#embedChanged(changedChunks);
      for (const task of changedProjectTasks) {
        try { await this.projectTaskSyncHandler?.(task); }
        catch (error) {
          this.database.audit("obsidian.task-sync-failed", `Could not synchronize task note ${task.path}`, {
            metadata: { error: String(error.message || error).slice(0, 500) }
          });
        }
      }
      for (const specification of changedToolSpecs) {
        try { await this.toolSpecHandler?.(specification); }
        catch (error) {
          this.database.audit("tool-recipe.vault-edit-invalid", `Ignored invalid tool specification edit: ${specification.path}`, {
            metadata: { error: String(error.message || error).slice(0, 500) }
          });
        }
      }
      this.database.raw.prepare(`UPDATE vault_sync_runs SET status='complete',scanned=?,changed=?,missing=?,completed_at=? WHERE id=?`)
        .run(scanned, changed, missing.length, now(), runId);
      this.database.raw.prepare("UPDATE vault_connection SET status='connected',last_sync_at=?,last_error='',updated_at=? WHERE id=1").run(now(), now());
      this.database.audit("obsidian.synced", `Synced ${scanned} Obsidian files`, { metadata: { scanned, changed, missing: missing.length } });
      return { ...this.status(), scanned, changed };
    } catch (error) {
      this.database.raw.prepare("UPDATE vault_sync_runs SET status='failed',error=?,completed_at=? WHERE id=?").run(error.message.slice(0, 1000), now(), runId);
      this.#setConnectionError(error.message);
      throw error;
    }
  }

  async #embedChanged(chunks) {
    if (!this.embedText || !chunks.length) return;
    for (const chunk of chunks.slice(0, 500)) {
      try {
        const embedding = await this.embedText(EMBEDDING_MODEL, chunk.text);
        this.database.raw.prepare(`UPDATE vault_chunks SET embedding=?,embedding_model=?,embedding_status='semantic' WHERE id=?`)
          .run(encodeVector(embedding), EMBEDDING_MODEL, chunk.id);
      } catch {
        break; // Ollama/model unavailable: all remaining chunks stay lexical.
      }
    }
  }

  async #migrateExisting(root) {
    const receipt = this.database.raw.prepare("SELECT 1 FROM migration_receipts WHERE source = 'obsidian-live-v1'").get();
    if (receipt) return;
    const nodes = this.database.listMemoryNodes();
    if (!nodes.length) {
      this.database.raw.prepare("INSERT INTO migration_receipts(id,source,fingerprint,counts_json,created_at) VALUES (?,'obsidian-live-v1',?,?,?)")
        .run(crypto.randomUUID(), hash("empty"), JSON.stringify({ exported: 0 }), now());
      return;
    }
    const memoryRoot = path.join(root, "Memory");
    await fsp.mkdir(memoryRoot, { recursive: true });
    const memoryEntries = await fsp.readdir(memoryRoot);
    const taken = new Set(memoryEntries.map((name) => name.toLowerCase()));
    const existingById = new Map();
    for (const filename of memoryEntries.filter((name) => name.toLowerCase().endsWith(".md"))) {
      try {
        const content = await fsp.readFile(path.join(memoryRoot, filename), "utf8");
        const parsed = parseMarkdown(normalizedRelative(path.join("Memory", filename)), content);
        if (parsed.id) existingById.set(parsed.id, { filename, parsed });
      } catch { /* leave malformed existing files untouched */ }
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = this.database.listMemoryEdges();
    let exported = 0;
    const verifiedIds = new Set();
    let verifiedLinks = 0;
    for (const node of nodes) {
      const related = edges.flatMap((edge) => {
        if (edge.fromId !== node.id) return [];
        const linked = byId.get(edge.toId);
        return linked ? [{ relation: edge.relation || "relates-to", title: linked.title }] : [];
      });
      const previouslyWritten = existingById.get(node.id);
      if (previouslyWritten) {
        const linkKeys = new Set((previouslyWritten.parsed.links || []).map((link) =>
          `${String(link.title).toLowerCase()}:${String(link.relation || "relates-to").toLowerCase()}`
        ));
        if (!related.every((link) => linkKeys.has(`${link.title.toLowerCase()}:${link.relation.toLowerCase()}`))) {
          throw new Error(`Obsidian migration link verification failed for ${previouslyWritten.filename}.`);
        }
        verifiedIds.add(node.id);
        verifiedLinks += related.length;
        exported += 1;
        continue;
      }
      const filename = vaultFilename(node.title, taken);
      const target = path.join(memoryRoot, filename);
      const content = [
        "---", `evolv_id: ${node.id}`, `title: ${JSON.stringify(node.title)}`, `type: ${node.type}`,
        `status: ${node.status}`, `source: ${node.source}`, `created: ${node.createdAt}`, `updated: ${node.updatedAt}`, "---", "", node.body || "",
        ...(related.length ? ["", "## Related", "", ...related.map((item) => `- ${item.relation} [[${item.title}]]`)] : []),
        ""
      ].join("\n");
      await this.#atomicWrite(target, content);
      const written = await fsp.readFile(target, "utf8");
      if (hash(written) !== hash(content)) throw new Error(`Obsidian migration verification failed for ${filename}.`);
      const parsed = parseMarkdown(normalizedRelative(path.join("Memory", filename)), written);
      if (parsed.id !== node.id) throw new Error(`Obsidian migration lost the stable id for ${filename}.`);
      verifiedIds.add(parsed.id);
      verifiedLinks += related.length;
      exported += 1;
    }
    if (exported !== nodes.length || verifiedIds.size !== nodes.length || verifiedLinks !== edges.length) {
      throw new Error("Obsidian migration row, id, or link verification failed. SQLite memory was left unchanged.");
    }
    const fingerprint = hash(nodes.map((node) => `${node.id}:${node.updatedAt}`).join("|"));
    this.database.raw.prepare("INSERT INTO migration_receipts(id,source,fingerprint,counts_json,created_at) VALUES (?,'obsidian-live-v1',?,?,?)")
      .run(crypto.randomUUID(), fingerprint, JSON.stringify({ exported, source: nodes.length, ids: verifiedIds.size, links: verifiedLinks }), now());
    this.database.audit("obsidian.memory-migrated", `Migrated ${exported} existing memories into Obsidian`, {
      metadata: { exported, source: nodes.length, ids: verifiedIds.size, links: verifiedLinks }
    });
  }

  #note(row) {
    return row ? {
      id: row.id, path: row.relative_path, title: row.title, type: row.type, status: row.status,
      format: row.format, body: row.body, tags: safeJson(row.tags_json, []), missing: Boolean(row.missing),
      aliases: safeJson(row.aliases_json, []),
      source: row.source, updatedAt: row.updated_at
    } : null;
  }

  list({ query = "", limit = 100 } = {}) {
    const rows = this.database.raw.prepare(`SELECT * FROM vault_notes WHERE missing=0
      ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit) || 100)));
    const needle = String(query || "").trim().toLowerCase();
    return rows.map((row) => this.#note(row))
      .filter((note) => !needle || `${note.title} ${note.path} ${note.tags.join(" ")} ${note.aliases.join(" ")}`.toLowerCase().includes(needle));
  }

  read(noteId, { heading = "", maxChars = 12_000 } = {}) {
    const note = this.#note(this.database.raw.prepare("SELECT * FROM vault_notes WHERE id=? AND missing=0").get(noteId));
    if (!note) throw Object.assign(new Error("Obsidian note not found."), { status: 404 });
    let content = note.body;
    if (heading) {
      const chunks = this.database.raw.prepare("SELECT heading,text FROM vault_chunks WHERE note_id=? ORDER BY ordinal").all(noteId);
      content = chunks.find((item) => item.heading.toLowerCase() === String(heading).toLowerCase())?.text || "";
    }
    return { ...note, body: content.slice(0, Math.max(100, Math.min(24_000, Number(maxChars) || 12_000))) };
  }

  backlinks(noteId) {
    const target = this.database.raw.prepare("SELECT title,aliases_json FROM vault_notes WHERE id=?").get(noteId);
    if (!target) throw Object.assign(new Error("Obsidian note not found."), { status: 404 });
    const names = new Set([target.title, ...safeJson(target.aliases_json, [])].map((item) => String(item).toLowerCase()));
    return this.database.raw.prepare(`SELECT n.id,n.title,n.relative_path AS path,l.relation,l.target_title AS targetTitle
      FROM vault_links l JOIN vault_notes n ON n.id=l.from_note_id
      WHERE n.missing=0 ORDER BY n.title LIMIT 1000`).all()
      .filter((item) => names.has(String(item.targetTitle).toLowerCase()))
      .slice(0, 100).map(({ targetTitle, ...item }) => item);
  }

  async search(query, limit = 6) {
    const text = String(query || "").trim();
    if (!text) return [];
    const chunks = this.database.raw.prepare(`SELECT c.*,n.title,n.relative_path AS path,n.type,n.status
      FROM vault_chunks c JOIN vault_notes n ON n.id=c.note_id WHERE n.missing=0 AND n.status='active'`).all();
    let queryEmbedding = null;
    if (this.embedText && chunks.some((item) => item.embedding_model === EMBEDDING_MODEL)) {
      try { queryEmbedding = await this.embedText(EMBEDDING_MODEL, text); } catch {}
    }
    return chunks.map((item) => ({
      id: item.note_id,
      title: item.title,
      path: item.path,
      heading: item.heading,
      type: item.type,
      status: item.status,
      body: item.text,
      score: queryEmbedding && item.embedding
        ? cosineSimilarity(queryEmbedding, decodeVector(item.embedding))
        : lexicalSimilarity(text, `${item.title} ${item.heading} ${item.text}`)
    })).filter((item) => item.score >= (queryEmbedding ? 0.2 : 0.05))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 6)));
  }

  async retrieve(query) {
    return (await this.search(query, 6)).map((item) => ({
      ...item,
      links: [],
      vault: { path: item.path, heading: item.heading }
    }));
  }

  async writeApprovedMemory(node) {
    if (!this.connected()) return null;
    const root = this.#connection().rootPath;
    const existing = this.database.raw.prepare("SELECT * FROM vault_notes WHERE id=?").get(node.id);
    const memoryRoot = path.join(root, "Memory");
    await fsp.mkdir(memoryRoot, { recursive: true });
    const taken = new Set((await fsp.readdir(memoryRoot)).map((name) => name.toLowerCase()));
    const relativePath = existing?.relative_path
      || normalizedRelative(path.join("Memory", vaultFilename(node.title || "Memory", taken)));
    const target = await this.#safePath(root, relativePath, { mayNotExist: true });
    const previous = await fsp.readFile(target, "utf8").catch(() => "");
    const parsed = parseFrontmatter(previous);
    const known = new Set(["evolv_id", "title", "type", "status", "source", "updated"]);
    const preserved = parsed.raw.split(/\r?\n/).filter((line) => {
      const key = line.match(/^([A-Za-z_][\w-]*):/)?.[1];
      return !key || !known.has(key);
    });
    const content = [
      "---",
      ...preserved,
      `evolv_id: ${node.id}`,
      `title: ${JSON.stringify(String(node.title || "Memory").slice(0, 200))}`,
      `type: ${MEMORY_TYPES.has(node.type) ? node.type : "note"}`,
      `status: ${MEMORY_STATUSES.has(node.status) ? node.status : "active"}`,
      `source: ${node.source || "approved-memory"}`,
      `updated: ${node.updatedAt || now()}`,
      "---",
      "",
      String(node.body || "").slice(0, 100_000),
      ""
    ].join("\n");
    await this.#atomicWrite(target, content);
    await this.sync();
    this.database.audit("obsidian.memory-written", `Wrote approved memory: ${node.title}`, {
      entityType: "memory", entityId: node.id, metadata: { path: relativePath }
    });
    return this.database.raw.prepare("SELECT id,relative_path AS path,title FROM vault_notes WHERE id=?").get(node.id) || null;
  }

  proposeChange({ kind, noteId = "", path: requestedPath = "", destinationPath = "", content = "", summary = "",
    conversationId = null, messageId = null, runId: toolRunId = null, agentRunId = null }) {
    if (!["create", "edit", "move", "archive"].includes(kind)) throw Object.assign(new Error("Invalid Obsidian change type."), { status: 400 });
    const existing = noteId ? this.database.raw.prepare("SELECT * FROM vault_notes WHERE id=? AND missing=0").get(noteId) : null;
    if (kind !== "create" && !existing) throw Object.assign(new Error("Choose an existing Obsidian note."), { status: 404 });
    const relativePath = normalizedRelative(kind === "create" ? requestedPath : existing.relative_path);
    if (!relativePath.toLowerCase().endsWith(".md") || !relativePath || relativePath.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      throw Object.assign(new Error("Obsidian changes require a safe vault-relative .md path."), { status: 400 });
    }
    const destination = normalizedRelative(destinationPath);
    if (kind === "move" && (!destination.toLowerCase().endsWith(".md") || destination.split("/").some((segment) => segment === ".." || segment.startsWith(".")))) {
      throw Object.assign(new Error("Move destination must be a safe vault-relative .md path."), { status: 400 });
    }
    const id = crypto.randomUUID();
    this.database.raw.prepare(`INSERT INTO vault_changes(id,kind,note_id,relative_path,destination_path,before_content,
      after_content,summary,status,conversation_id,message_id,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?)`)
      .run(id, kind, existing?.id || null, relativePath, destination, existing?.body || "", String(content || "").slice(0, 100_000),
        String(summary || "").slice(0, 500), conversationId, messageId, now(), new Date(Date.now() + 30 * 60_000).toISOString());
    if (this.approvalService) {
      const message = messageId ? this.database.raw.prepare("SELECT metadata_json FROM messages WHERE id=?").get(messageId) : null;
      let metadata = {}; try { metadata = JSON.parse(message?.metadata_json || "{}"); } catch {}
      this.approvalService.create({
        kind: `obsidian-${kind}`,
        resourceType: "obsidian-change",
        resourceId: id,
        toolRunId,
        conversationId,
        agentRunId: agentRunId || metadata.agentRunId || null,
        summary: String(summary || `Approve Obsidian ${kind}`).slice(0, 1000),
        before: { path: relativePath, content: existing?.body || "" },
        after: { path: kind === "move" ? destination : relativePath, content: String(content || "").slice(0, 100_000), kind },
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
      });
    }
    this.database.audit("obsidian.change-proposed", `Proposed Obsidian ${kind}: ${relativePath}`, { entityType: "vault-change", entityId: id });
    return this.getChange(id);
  }

  getChange(id) {
    const row = this.database.raw.prepare(`SELECT id,kind,note_id AS noteId,relative_path AS path,
      destination_path AS destinationPath,before_content AS beforeContent,after_content AS afterContent,
      summary,status,conversation_id AS conversationId,message_id AS messageId,created_at AS createdAt,
      reviewed_at AS reviewedAt,expires_at AS expiresAt FROM vault_changes WHERE id=?`).get(id);
    return row || null;
  }

  listChanges(status = "pending", limit = 100) {
    const rows = status
      ? this.database.raw.prepare("SELECT id FROM vault_changes WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, Math.min(500, Number(limit) || 100))
      : this.database.raw.prepare("SELECT id FROM vault_changes ORDER BY created_at DESC LIMIT ?").all(Math.min(500, Number(limit) || 100));
    return rows.map((row) => this.getChange(row.id));
  }

  async decideChange(id, decision) {
    const change = this.getChange(id);
    if (!change || change.status !== "pending") throw Object.assign(new Error("Pending Obsidian change not found."), { status: 404 });
    const approval = this.approvalService?.getByResource("obsidian-change", id);
    if (Date.parse(change.expiresAt) < Date.now()) {
      this.database.raw.prepare("UPDATE vault_changes SET status='expired',reviewed_at=? WHERE id=?").run(now(), id);
      throw Object.assign(new Error("This Obsidian change expired. Ask Evolv to propose it again."), { status: 409 });
    }
    if (decision === "rejected") {
      if (approval?.status === "pending") this.approvalService.decide(approval.id, "rejected");
      this.database.raw.prepare("UPDATE vault_changes SET status='rejected',reviewed_at=? WHERE id=?").run(now(), id);
      this.database.audit("obsidian.change-rejected", `Rejected Obsidian ${change.kind}`, { entityType: "vault-change", entityId: id });
      return this.getChange(id);
    }
    if (decision !== "approved") throw Object.assign(new Error("Decision must be approved or rejected."), { status: 400 });
    if (approval?.status === "pending") this.approvalService.decide(approval.id, "approved");
    try {
      const root = this.#connection()?.rootPath;
      if (!root) throw Object.assign(new Error("Obsidian vault is disconnected."), { status: 409 });
      const source = await this.#safePath(root, change.path, { mayNotExist: change.kind === "create" });
      if (change.kind === "create") {
        try {
          const info = await fsp.stat(source);
          if (info) throw Object.assign(new Error("The proposed note path now exists. Review a new edit proposal instead."), { status: 409 });
        } catch (error) {
          if (error.status === 409) throw error;
          if (error.code !== "ENOENT") throw error;
        }
      }
      const previous = change.kind === "create" ? "" : await fsp.readFile(source, "utf8");
      if (change.kind !== "create") {
        const currentBody = parseFrontmatter(previous).body.trim();
        if (currentBody !== String(change.beforeContent || "").trim()) {
          throw Object.assign(new Error("This note changed in Obsidian after the diff was proposed. Sync and review a fresh diff."), { status: 409 });
        }
      }
      this.database.raw.prepare(`INSERT OR REPLACE INTO vault_change_backups(change_id,relative_path,previous_content,created_at) VALUES (?,?,?,?)`)
        .run(id, change.path, previous, now());
      if (change.kind === "create" || change.kind === "edit") {
        const body = change.afterContent;
        const managed = change.kind === "create"
          ? `---\nevolv_id: ${crypto.randomUUID()}\ntype: note\nstatus: active\nsource: approved-tool\n---\n\n${body}\n`
          : this.#replaceBodyPreservingFrontmatter(previous, body);
        await this.#atomicWrite(source, managed);
      } else {
        const destinationRelative = change.kind === "archive"
          ? normalizedRelative(path.join("Archive", path.basename(change.path))) : change.destinationPath;
        const destination = await this.#safePath(root, destinationRelative, { mayNotExist: true });
        try {
          await fsp.stat(destination);
          throw Object.assign(new Error("The destination note path already exists. Review a different destination."), { status: 409 });
        } catch (error) {
          if (error.status === 409) throw error;
          if (error.code !== "ENOENT") throw error;
        }
        if (change.kind === "archive") {
          await this.#atomicWrite(source, this.#setFrontmatterField(previous, "status", "archived"));
        }
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.rename(source, destination);
      }
      this.database.raw.prepare("UPDATE vault_changes SET status='approved',reviewed_at=? WHERE id=?").run(now(), id);
      if (approval) this.approvalService.markExecuted(approval.id, { changeId: id, kind: change.kind });
      await this.sync();
      this.database.audit("obsidian.change-approved", `Approved Obsidian ${change.kind}`, { entityType: "vault-change", entityId: id });
      return this.getChange(id);
    } catch (error) {
      if (approval) this.approvalService.fail(approval.id, error);
      throw error;
    }
  }

  async undoChange(id) {
    const change = this.getChange(id);
    if (!change || change.status !== "approved") throw Object.assign(new Error("Approved Obsidian change not found."), { status: 404 });
    const backup = this.database.raw.prepare("SELECT * FROM vault_change_backups WHERE change_id=?").get(id);
    const root = this.#connection()?.rootPath;
    if (!backup || !root) throw Object.assign(new Error("No undo snapshot is available."), { status: 409 });
    const target = await this.#safePath(root, backup.relative_path, { mayNotExist: true });
    if (change.kind === "create" && !backup.previous_content) {
      const current = await fsp.readFile(target, "utf8").catch(() => "");
      if (parseFrontmatter(current).body.trim() !== String(change.afterContent || "").trim()) {
        throw Object.assign(new Error("The created note changed after approval; undo was not applied."), { status: 409 });
      }
      await fsp.rm(target, { force: true });
    } else if (change.kind === "move" || change.kind === "archive") {
      const destinationRelative = change.kind === "archive"
        ? normalizedRelative(path.join("Archive", path.basename(change.path))) : change.destinationPath;
      const destination = await this.#safePath(root, destinationRelative);
      try {
        await fsp.stat(target);
        throw Object.assign(new Error("The original note path is occupied; undo was not applied."), { status: 409 });
      } catch (error) {
        if (error.status === 409) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(destination, target);
      if (change.kind === "archive") await this.#atomicWrite(target, backup.previous_content);
    } else {
      const current = await fsp.readFile(target, "utf8");
      if (parseFrontmatter(current).body.trim() !== String(change.afterContent || "").trim()) {
        throw Object.assign(new Error("The edited note changed after approval; undo was not applied."), { status: 409 });
      }
      await this.#atomicWrite(target, backup.previous_content);
    }
    this.database.raw.prepare("UPDATE vault_changes SET status='undone',reviewed_at=? WHERE id=?").run(now(), id);
    await this.sync();
    this.database.audit("obsidian.change-undone", `Undid Obsidian ${change.kind}`, { entityType: "vault-change", entityId: id });
    return this.getChange(id);
  }

  #replaceBodyPreservingFrontmatter(original, body) {
    const match = String(original).match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
    return `${match?.[1] || ""}${String(body || "").trim()}\n`;
  }

  #setFrontmatterField(original, key, value) {
    const text = String(original || "");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return `---\n${key}: ${value}\n---\n\n${text}`;
    const line = new RegExp(`^${key}:.*$`, "m");
    const frontmatter = line.test(match[1])
      ? match[1].replace(line, `${key}: ${value}`)
      : `${match[1]}\n${key}: ${value}`;
    return text.replace(match[0], `---\n${frontmatter}\n---`);
  }

  async #safePath(root, relative, { mayNotExist = false } = {}) {
    const base = await fsp.realpath(root);
    const target = path.resolve(base, normalizedRelative(relative));
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Vault path escaped its root.");
    if (mayNotExist) {
      let ancestor = path.dirname(target);
      let parent = null;
      while (!parent) {
        try {
          parent = await fsp.realpath(ancestor);
        } catch {
          const next = path.dirname(ancestor);
          if (next === ancestor) throw new Error("Vault path has no valid parent.");
          ancestor = next;
        }
      }
      if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) throw new Error("Vault path escaped through a symlink.");
      return target;
    }
    const real = await fsp.realpath(target);
    if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error("Vault path escaped through a symlink.");
    return real;
  }

  async #atomicWrite(target, content) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, target);
  }

  #projectSlug(value) {
    return String(value || "Project").normalize("NFKD").replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80) || "Project";
  }

  async ensureRunJournal({ run, project }) {
    if (!this.connected()) return { connected: false, journal: null };
    if (!run?.id || !project?.id) throw new Error("A run and project are required for an Obsidian journal.");
    const existing = this.database.raw.prepare(`SELECT run_id AS runId,project_id AS projectId,relative_path AS relativePath,
      evolv_id AS evolvId,last_event_sequence AS lastEventSequence,content_hash AS contentHash,status FROM run_journal_mappings WHERE run_id=?`).get(run.id);
    if (existing) return { connected: true, journal: existing };
    const root = this.#connection().rootPath;
    const projectSlug = this.#projectSlug(project.name);
    const baseRelative = normalizedRelative(path.join("Projects", projectSlug));
    const folders = ["Tasks", "Decisions", "Runs", "Artifacts"];
    for (const folder of folders) await fsp.mkdir(await this.#safePath(root, path.join(baseRelative, folder), { mayNotExist: true }), { recursive: true });
    const projectFile = await this.#safePath(root, path.join(baseRelative, "Project.md"), { mayNotExist: true });
    try { await fsp.access(projectFile); }
    catch {
      const projectId = crypto.randomUUID();
      await this.#atomicWrite(projectFile, [
        "---", `evolv_id: ${projectId}`, `project_id: ${project.id}`, "type: project", "status: active",
        `created: ${now()}`, `updated: ${now()}`, "tags: [evolv, project]", "---", "",
        `# ${project.name}`, "", project.description || "Evolv project journal.", ""
      ].join("\n"));
    }
    const evolvId = crypto.randomUUID();
    const relativePath = normalizedRelative(path.join(baseRelative, "Runs", `${run.id}.md`));
    const target = await this.#safePath(root, relativePath, { mayNotExist: true });
    const activePlan = run.plans?.find((item) => item.status === "active") || run.plans?.at(-1);
    const criteria = run.goal?.successCriteria || run.request?.successCriteria || [];
    const content = [
      "---", `evolv_id: ${evolvId}`, `project_id: ${project.id}`, `run_id: ${run.id}`, "type: run-journal",
      "status: approved", `created: ${now()}`, `updated: ${now()}`, "tags: [evolv, agent-run]", "---", "",
      `# ${run.objective.slice(0, 160)}`, "", `Project: [[../Project|${project.name}]]`, "", "## Objective", "", run.objective, "",
      "## Success criteria", "", ...(criteria.length ? criteria.map((item) => `- [ ] ${item}`) : ["- [ ] Verify the stated goal with recorded evidence."]), "",
      "## Approved plan", "", ...(activePlan?.definition?.steps || []).map((step, index) => `${index + 1}. **${step.title}** — ${step.description}`), "",
      "## Durable event log", "", "<!-- Evolv appends deterministic facts below. Event IDs prevent duplicates. -->", ""
    ].join("\n");
    await this.#atomicWrite(target, content);
    const contentHash = hash(content);
    const stamp = now();
    this.database.raw.prepare(`INSERT INTO run_journal_mappings(run_id,project_id,relative_path,evolv_id,last_event_sequence,content_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,0,?,'active',?,?)`).run(run.id, project.id, relativePath, evolvId, contentHash, stamp, stamp);
    this.database.audit("obsidian.run-journal-created", `Created managed run journal for ${run.id}`, {
      entityType: "agent-run", entityId: run.id, metadata: { relativePath }
    });
    await this.sync().catch(() => {});
    return { connected: true, journal: this.database.raw.prepare(`SELECT run_id AS runId,project_id AS projectId,relative_path AS relativePath,
      evolv_id AS evolvId,last_event_sequence AS lastEventSequence,content_hash AS contentHash,status FROM run_journal_mappings WHERE run_id=?`).get(run.id) };
  }

  #journalEventLine(event) {
    const label = String(event.type || "event").replaceAll(".", " ");
    const payload = event.payload && Object.keys(event.payload).length
      ? ` — ${JSON.stringify(event.payload).slice(0, 4000)}` : "";
    return `- ${event.createdAt} · **${label}**${payload} <!-- evolv-event:${event.id} -->`;
  }

  async syncRunJournal({ run, project }) {
    const ensured = await this.ensureRunJournal({ run, project });
    if (!ensured.connected) return ensured;
    const mapping = ensured.journal;
    const root = this.#connection().rootPath;
    let target;
    let current;
    try {
      target = await this.#safePath(root, mapping.relativePath);
      current = await fsp.readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.database.raw.prepare("UPDATE run_journal_mappings SET status='missing',updated_at=? WHERE run_id=?").run(now(), run.id);
      return { connected: true, missing: true, journal: { ...mapping, status: "missing" } };
    }
    if (mapping.contentHash && hash(current) !== mapping.contentHash) {
      this.database.raw.prepare("UPDATE run_journal_mappings SET status='conflict',updated_at=? WHERE run_id=?").run(now(), run.id);
      this.database.audit("obsidian.run-journal-conflict", `Managed journal changed outside Evolv for ${run.id}`, { entityType: "agent-run", entityId: run.id });
      return { connected: true, conflict: true, journal: { ...mapping, status: "conflict" } };
    }
    const pending = (run.events || []).filter((event) => Number(event.sequence) > Number(mapping.lastEventSequence || 0));
    if (!pending.length) return { connected: true, journal: mapping, appended: 0 };
    const addition = `${pending.map((event) => this.#journalEventLine(event)).join("\n")}\n`;
    const nextContent = `${current.replace(/\s*$/, "\n")}${addition}`;
    await this.#atomicWrite(target, nextContent);
    const lastSequence = Math.max(...pending.map((event) => Number(event.sequence)));
    const status = run.state === "completed" ? "complete" : "active";
    this.database.raw.prepare(`UPDATE run_journal_mappings SET last_event_sequence=?,content_hash=?,status=?,updated_at=? WHERE run_id=?`)
      .run(lastSequence, hash(nextContent), status, now(), run.id);
    return { connected: true, appended: pending.length, journal: { ...mapping, lastEventSequence: lastSequence, status } };
  }

  journalForRun(runId) {
    const row = this.database.raw.prepare(`SELECT m.run_id AS runId,m.project_id AS projectId,m.relative_path AS relativePath,m.evolv_id AS evolvId,
      m.last_event_sequence AS lastEventSequence,m.content_hash AS contentHash,m.status,n.id AS noteId
      FROM run_journal_mappings m LEFT JOIN vault_notes n ON n.relative_path=m.relative_path WHERE m.run_id=?`).get(runId);
    return row || null;
  }

  async open(noteId = "") {
    const connection = this.#connection();
    if (!connection || !this.host) throw Object.assign(new Error("Open in Obsidian is available only in the Evolv desktop app."), { status: 409 });
    const note = noteId ? this.database.raw.prepare("SELECT relative_path FROM vault_notes WHERE id=?").get(noteId) : null;
    return this.host.openVault(connection.rootPath, note?.relative_path || "");
  }

  close() {
    this.closed = true;
    this.#stopWatcher();
    const connection = this.#connection();
    if (connection?.rootPath) this.host?.releaseRoot(this.profileId, connection.rootPath);
  }
}

export const vaultLimits = Object.freeze({ MAX_MARKDOWN, MAX_CANVAS, MAX_FILES });
