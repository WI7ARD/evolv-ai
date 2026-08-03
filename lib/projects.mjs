import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_FILES = 500;
const MAX_INDEX_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 500;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".css", ".html",
  ".htm", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".ps1", ".yaml", ".yml",
  ".toml", ".ini", ".sql", ".xml", ".csv"
]);
const DENIED_SEGMENTS = new Set([".git", "node_modules", "data", "backups", ".obsidian", ".trash", "dist", "out"]);
const SECRET_NAMES = [/^\.env(?:\.|$)/i, /credential/i, /secret/i, /private[-_. ]?key/i, /\.pem$/i, /\.pfx$/i, /\.key$/i];

function now() { return new Date().toISOString(); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function parseJson(value, fallback = {}) { try { return JSON.parse(value || "{}"); } catch { return fallback; } }
function fail(message, status = 400, code = "PROJECT_INVALID") { return Object.assign(new Error(message), { status, code }); }
function bounded(value, length) { return String(value || "").trim().slice(0, length); }
function safeName(value) { return bounded(value, 120).replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim(); }
function canonicalHash(root) { return hash(process.platform === "win32" ? root.toLowerCase() : root); }
function isDenied(relative) {
  const segments = String(relative).split(/[\\/]/).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return DENIED_SEGMENTS.has(lower) || lower.startsWith("out-") || lower.startsWith("dist-")
      || SECRET_NAMES.some((pattern) => pattern.test(segment)) || segment.startsWith(".");
  });
}

function decodePdfString(input) {
  return input.replace(/\\([nrtbf()\\])/g, (_match, token) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[token]))
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\\r?\n/g, "");
}

export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw fail("The file is not a valid PDF.", 400, "INVALID_PDF");
  const source = buffer.toString("latin1");
  if (/\/Encrypt\b/.test(source)) throw fail("Encrypted PDFs are not supported.", 400, "PDF_ENCRYPTED");
  const sections = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  let streamNumber = 0;
  while ((match = streamPattern.exec(source)) && sections.length < 500) {
    streamNumber += 1;
    const dictionary = source.slice(Math.max(0, match.index - 500), match.index);
    let content = Buffer.from(match[1], "latin1");
    if (/\/FlateDecode\b/.test(dictionary)) {
      try { content = inflateSync(content); } catch { continue; }
    }
    const decoded = content.toString("latin1");
    const blocks = decoded.match(/BT[\s\S]*?ET/g) || [];
    const tokens = [];
    for (const block of blocks) {
      const tokenPattern = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:.|\r|\n)*?)\]\s*TJ/g;
      let token;
      while ((token = tokenPattern.exec(block))) {
        if (token[1] != null) tokens.push(decodePdfString(token[1]));
        else {
          const fragments = [];
          const fragmentPattern = /\(((?:\\.|[^\\)])*)\)/g;
          let fragment;
          while ((fragment = fragmentPattern.exec(token[2]))) fragments.push(decodePdfString(fragment[1]));
          if (fragments.length) tokens.push(fragments.join(""));
        }
      }
    }
    const text = tokens.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    if (text) sections.push({ locator: `PDF stream ${streamNumber}`, content: text });
  }
  if (!sections.length) throw fail("No extractable text was found. This may be a scanned PDF; OCR is not configured.", 422, "PDF_TEXT_UNAVAILABLE");
  return sections;
}

export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw fail("Image data is incomplete.", 400, "INVALID_IMAGE");
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (buffer.length < 24) throw fail("PNG data is incomplete.", 400, "INVALID_IMAGE");
    return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mimeType: "image/jpeg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: "jpeg" };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw fail("JPEG dimensions could not be verified.", 400, "INVALID_IMAGE");
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", width: null, height: null, format: "webp" };
  }
  throw fail("Only signature-verified PNG, JPEG, and WebP images are supported.", 415, "IMAGE_TYPE_UNSUPPORTED");
}

function chunkText(text, kind = "text") {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  if (!normalized) return [];
  const chunks = [];
  if (kind === "markdown") {
    let heading = "Document";
    let lines = [];
    const flush = () => {
      const content = lines.join("\n").trim();
      if (content) chunks.push({ locator: heading, content });
      lines = [];
    };
    for (const line of normalized.split("\n")) {
      const header = line.match(/^#{1,6}\s+(.+)/);
      if (header) { flush(); heading = header[1].trim().slice(0, 200); }
      else lines.push(line);
    }
    flush();
  } else {
    const lines = normalized.split("\n");
    for (let start = 0; start < lines.length; start += 80) {
      const end = Math.min(lines.length, start + 100);
      chunks.push({ locator: `lines ${start + 1}-${end}`, content: lines.slice(start, end).join("\n").trim() });
    }
  }
  return chunks.filter((item) => item.content).slice(0, MAX_CHUNKS).flatMap((item) => {
    if (item.content.length <= 8_000) return [item];
    const parts = [];
    for (let start = 0; start < item.content.length && parts.length < MAX_CHUNKS; start += 7_500) {
      parts.push({ locator: `${item.locator} / part ${parts.length + 1}`, content: item.content.slice(start, start + 8_000) });
    }
    return parts;
  }).slice(0, MAX_CHUNKS);
}

function scoreText(query, title, locator, content) {
  const terms = String(query).toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  if (!terms.length) return 0;
  const titleText = `${title} ${locator}`.toLowerCase();
  const body = content.toLowerCase();
  return terms.reduce((score, term) => score + (titleText.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0) / terms.length;
}

export class ProjectService {
  constructor({ database, profileId, profileDir, host = null, legacyWorkspaceRoot = "" }) {
    this.database = database;
    this.db = database.raw;
    this.profileId = profileId;
    this.profileDir = profileDir;
    this.host = host;
    this.legacyWorkspaceRoot = legacyWorkspaceRoot ? path.resolve(legacyWorkspaceRoot) : "";
    this.artifactsDir = path.join(profileDir, "artifacts");
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  async initialize() {
    let project = this.db.prepare("SELECT id FROM projects WHERE is_default=1").get();
    if (!project) {
      const id = crypto.randomUUID();
      const stamp = now();
      this.db.prepare("INSERT INTO projects(id,name,description,status,is_default,created_at,updated_at) VALUES (?,?,?,'active',1,?,?)")
        .run(id, "Personal project", "Non-destructive default project created during the Stage 4 migration.", stamp, stamp);
      project = { id };
    }
    if (this.legacyWorkspaceRoot && !this.db.prepare("SELECT 1 FROM project_grants WHERE project_id=?").get(project.id)) {
      const canonical = await fsp.realpath(this.legacyWorkspaceRoot);
      this.#saveGrant(project.id, canonical, path.basename(canonical) || "Evolv workspace", "legacy-workspace-migration");
    }
    const receipt = this.db.prepare("SELECT 1 FROM migration_receipts WHERE fingerprint='stage4:project-memory-v1'").get();
    if (!receipt) {
      const stamp = now();
      const result = this.db.prepare("INSERT OR IGNORE INTO project_memory(project_id,memory_id,scope,created_at) SELECT ?,id,'project',? FROM memory_nodes").run(project.id, stamp);
      this.db.prepare("INSERT INTO migration_receipts(id,source,fingerprint,counts_json,created_at) VALUES (?,?,?,?,?)")
        .run(crypto.randomUUID(), "stage4-project-memory", "stage4:project-memory-v1", JSON.stringify({ linked: result.changes }), stamp);
    }
    return this.get(project.id);
  }

  #saveGrant(projectId, root, label, source) {
    const stamp = now();
    this.db.prepare(`INSERT INTO project_grants(project_id,root_path,canonical_hash,label,source,created_at,verified_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET root_path=excluded.root_path,canonical_hash=excluded.canonical_hash,
      label=excluded.label,source=excluded.source,verified_at=excluded.verified_at`)
      .run(projectId, root, canonicalHash(root), safeName(label) || "Project folder", source, stamp, stamp);
  }

  get(id) {
    const row = this.db.prepare(`SELECT p.id,p.name,p.description,p.status,p.is_default AS isDefault,p.created_at AS createdAt,p.updated_at AS updatedAt,
      g.label AS folderLabel,g.source AS grantSource,g.verified_at AS grantVerifiedAt
      FROM projects p LEFT JOIN project_grants g ON g.project_id=p.id WHERE p.id=?`).get(id);
    if (!row) return null;
    return { ...row, isDefault: Boolean(row.isDefault), folderConnected: Boolean(row.folderLabel),
      counts: {
        tasks: this.db.prepare("SELECT COUNT(*) count FROM project_tasks WHERE project_id=?").get(id).count,
        files: this.db.prepare("SELECT COUNT(*) count FROM project_files WHERE project_id=?").get(id).count,
        artifacts: this.db.prepare("SELECT COUNT(*) count FROM project_artifacts WHERE project_id=?").get(id).count,
        sources: this.db.prepare("SELECT COUNT(*) count FROM project_knowledge_sources WHERE project_id=? AND status!='deleted'").get(id).count
      } };
  }

  list() { return this.db.prepare("SELECT id FROM projects ORDER BY is_default DESC,updated_at DESC").all().map((row) => this.get(row.id)); }
  defaultProject() { return this.list().find((item) => item.isDefault) || null; }

  create({ name, description = "" } = {}) {
    const validName = safeName(name);
    if (validName.length < 2) throw fail("Project name must be at least 2 characters.");
    const id = crypto.randomUUID(); const stamp = now();
    this.db.prepare("INSERT INTO projects(id,name,description,status,is_default,created_at,updated_at) VALUES (?,?,?,'active',0,?,?)")
      .run(id, validName, bounded(description, 2000), stamp, stamp);
    this.database.audit("project.created", `Created project ${validName}`, { entityType: "project", entityId: id });
    return this.get(id);
  }

  async createDemo() {
    const name = "Evolv Release Readiness Demo";
    const marker = "A safe, local Evolv demo for checking project memory, tasks, citations, and agent planning.";
    const existing = this.db.prepare("SELECT id FROM projects WHERE name=? AND description=?").get(name, marker);
    if (existing) return { created: false, project: this.get(existing.id) };

    const project = this.create({ name, description: marker });
    this.addTask(project.id, {
      title: "Plan a verified release",
      description: "Produce a bounded plan with tests, backup, rollback, and explicit acceptance criteria.",
      priority: 1
    });
    this.addTask(project.id, {
      title: "Diagnose the sample failure",
      description: "Use the indexed incident evidence. Do not claim the problem is fixed without a passing check.",
      priority: 2
    });
    await this.ingest(project.id, {
      title: "Demo brief",
      kind: "markdown",
      text: "# Goal\nPrepare a reliable desktop release without changing the public itch.io build.\n\n# Constraints\n- Back up user data first.\n- Keep secrets out of logs and exports.\n- Ask before risky writes.\n- Report Windows and Linux results separately.\n\n# Acceptance\nThe test suite passes, pack installation is verified after writing, and the Windows package launches with persistent data."
    });
    await this.ingest(project.id, {
      title: "Sample incident",
      kind: "markdown",
      text: "# Symptom\nA Marketplace Install click opens an approval panel but no server request is recorded.\n\n# Evidence\nThe server-side installer tests pass and the audit log contains no install attempt.\n\n# Expected approach\nInspect the renderer event path, block duplicate submissions, show errors inline, and verify the installed record before reporting success."
    });
    this.database.audit("project.demo-created", "Created the verified release-readiness demo", { entityType: "project", entityId: project.id });
    return { created: true, project: this.get(project.id) };
  }

  update(id, input = {}) {
    const project = this.get(id); if (!project) throw fail("Project not found.", 404, "PROJECT_NOT_FOUND");
    const name = input.name === undefined ? project.name : safeName(input.name);
    if (name.length < 2) throw fail("Project name must be at least 2 characters.");
    const status = input.status === undefined ? project.status : String(input.status);
    if (!["active", "archived"].includes(status)) throw fail("Project status is invalid.");
    this.db.prepare("UPDATE projects SET name=?,description=?,status=?,updated_at=? WHERE id=?")
      .run(name, input.description === undefined ? project.description : bounded(input.description, 2000), status, now(), id);
    return this.get(id);
  }

  async connectGrant(projectId, grant) {
    const project = this.get(projectId); if (!project) throw fail("Project not found.", 404, "PROJECT_NOT_FOUND");
    if (!this.host) throw fail("External project folders are available only in Evolv.exe.", 409, "DESKTOP_REQUIRED");
    const selected = this.host.consumeGrant(grant);
    const canonical = this.host.claimRoot(this.profileId, selected);
    const info = await fsp.stat(canonical);
    if (!info.isDirectory()) throw fail("The selected project must be a folder.");
    const old = this.db.prepare("SELECT root_path rootPath FROM project_grants WHERE project_id=?").get(projectId);
    if (old?.rootPath && old.rootPath !== canonical) this.host.releaseRoot(this.profileId, old.rootPath);
    this.#saveGrant(projectId, canonical, path.basename(canonical) || project.name, "desktop-picker");
    this.database.audit("project.folder-connected", `Connected a folder to ${project.name}`, { entityType: "project", entityId: projectId });
    return this.get(projectId);
  }

  async ensureTrustedGrant(root, { name = "Selected project", source = "trusted-desktop-config" } = {}) {
    const canonical = await fsp.realpath(path.resolve(root));
    const existing = this.db.prepare("SELECT project_id projectId FROM project_grants WHERE canonical_hash=?").get(canonicalHash(canonical));
    if (existing) return this.get(existing.projectId);
    const project = this.create({ name: safeName(name) || path.basename(canonical), description: "Project folder explicitly selected in Evolv desktop configuration." });
    this.host?.claimRoot(this.profileId, canonical);
    this.#saveGrant(project.id, canonical, path.basename(canonical), source);
    return this.get(project.id);
  }

  async rootFor(projectId) {
    if (!projectId) throw fail("Choose a project with a connected folder before using filesystem tools.", 409, "PROJECT_REQUIRED");
    const grant = this.db.prepare("SELECT root_path rootPath,canonical_hash canonicalHash FROM project_grants WHERE project_id=?").get(projectId);
    if (!grant) throw fail("This project has no connected folder.", 409, "PROJECT_FOLDER_REQUIRED");
    let canonical;
    try { canonical = await fsp.realpath(grant.rootPath); } catch { throw fail("The project folder is unavailable. Reconnect it.", 409, "PROJECT_FOLDER_MISSING"); }
    if (canonicalHash(canonical) !== grant.canonicalHash) throw fail("The project folder identity changed. Reconnect it.", 409, "PROJECT_GRANT_STALE");
    this.db.prepare("UPDATE project_grants SET verified_at=? WHERE project_id=?").run(now(), projectId);
    return canonical;
  }

  attachConversation(projectId, conversationId) {
    if (!this.get(projectId)) throw fail("Project not found.", 404, "PROJECT_NOT_FOUND");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_conversations WHERE conversation_id=? AND project_id!=?").run(conversationId, projectId);
      this.db.prepare("INSERT OR IGNORE INTO project_conversations(project_id,conversation_id,created_at) VALUES (?,?,?)").run(projectId, conversationId, now());
    })();
  }
  projectForConversation(conversationId) {
    const row = this.db.prepare("SELECT project_id projectId FROM project_conversations WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").get(conversationId);
    return row ? this.get(row.projectId) : null;
  }
  attachRun(projectId, runId) { this.db.prepare("INSERT OR IGNORE INTO project_runs(project_id,run_id,created_at) VALUES (?,?,?)").run(projectId, runId, now()); }

  addTask(projectId, input = {}) {
    if (!this.get(projectId)) throw fail("Project not found.", 404, "PROJECT_NOT_FOUND");
    const title = safeName(input.title); if (title.length < 2) throw fail("Task title must be at least 2 characters.");
    const priority = Math.max(1, Math.min(5, Number(input.priority) || 3)); const id = crypto.randomUUID(); const stamp = now();
    this.db.prepare("INSERT INTO project_tasks(id,project_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, projectId, title, bounded(input.description, 5000), "open", priority, stamp, stamp);
    return this.getTask(id);
  }
  getTask(id) { return this.db.prepare(`SELECT id,project_id AS projectId,title,description,status,priority,created_at AS createdAt,updated_at AS updatedAt FROM project_tasks WHERE id=?`).get(id) || null; }
  listTasks(projectId, status = "") {
    const rows = status ? this.db.prepare("SELECT id FROM project_tasks WHERE project_id=? AND status=? ORDER BY priority,updated_at DESC").all(projectId, status)
      : this.db.prepare("SELECT id FROM project_tasks WHERE project_id=? ORDER BY status,priority,updated_at DESC").all(projectId);
    return rows.map((row) => this.getTask(row.id));
  }
  updateTask(projectId, id, input = {}) {
    const task = this.getTask(id); if (!task || task.projectId !== projectId) throw fail("Task not found.", 404, "TASK_NOT_FOUND");
    const status = input.status ?? task.status; if (!["open", "in-progress", "blocked", "done", "archived"].includes(status)) throw fail("Task status is invalid.");
    const title = input.title === undefined ? task.title : safeName(input.title); if (title.length < 2) throw fail("Task title must be at least 2 characters.");
    this.db.prepare("UPDATE project_tasks SET title=?,description=?,status=?,priority=?,updated_at=? WHERE id=?").run(
      title, input.description === undefined ? task.description : bounded(input.description, 5000), status,
      input.priority === undefined ? task.priority : Math.max(1, Math.min(5, Number(input.priority) || 3)), now(), id);
    return this.getTask(id);
  }

  linkMemory(projectId, memoryId, scope = "project") {
    if (!["working", "project", "long-term", "strategy", "failure"].includes(scope)) throw fail("Memory scope is invalid.");
    if (!this.get(projectId) || !this.database.getMemoryNode(memoryId)) throw fail("Project or memory record not found.", 404, "NOT_FOUND");
    this.db.prepare("INSERT INTO project_memory(project_id,memory_id,scope,created_at) VALUES (?,?,?,?) ON CONFLICT(project_id,memory_id) DO UPDATE SET scope=excluded.scope")
      .run(projectId, memoryId, scope, now());
    return { projectId, memoryId, scope };
  }

  memoryGraph(projectId, scopes = ["working", "project", "long-term", "strategy", "failure"]) {
    if (!this.get(projectId)) return { nodes: [], edges: [] };
    const allowed = scopes.filter((scope) => ["working", "project", "long-term", "strategy", "failure"].includes(scope));
    if (!allowed.length) return { nodes: [], edges: [] };
    const placeholders = allowed.map(() => "?").join(",");
    const links = this.db.prepare(`SELECT memory_id AS memoryId,scope FROM project_memory WHERE project_id=? AND scope IN (${placeholders})`).all(projectId, ...allowed);
    const scopeById = new Map(links.map((item) => [item.memoryId, item.scope]));
    const nodes = links.map((item) => this.database.getMemoryNode(item.memoryId)).filter(Boolean).map((node) => ({ ...node, projectScope: scopeById.get(node.id) }));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = this.database.listMemoryEdges().filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId));
    return { nodes, edges };
  }

  async #storeArtifact(projectId, { runId = null, title, kind, mimeType, buffer, sourcePath = "", metadata = {} }) {
    const digest = hash(buffer);
    const existing = this.db.prepare("SELECT id FROM project_artifacts WHERE project_id=? AND sha256=?").get(projectId, digest);
    if (existing) return this.getArtifact(existing.id);
    const extension = ({ "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "text/markdown": ".md", "text/plain": ".txt" })[mimeType] || ".bin";
    const storageName = `${digest}${extension}`;
    const target = path.join(this.artifactsDir, storageName);
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      await fsp.rename(temporary, target);
    }
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO project_artifacts(id,project_id,run_id,title,kind,mime_type,sha256,size_bytes,storage_name,source_path,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, runId, bounded(title, 200), kind, mimeType, digest, buffer.length, storageName,
      bounded(sourcePath, 500), JSON.stringify(metadata), now());
    return this.getArtifact(id);
  }

  getArtifact(id) {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,run_id AS runId,title,kind,mime_type AS mimeType,sha256,size_bytes AS sizeBytes,
      source_path AS sourcePath,metadata_json AS metadataJson,created_at AS createdAt FROM project_artifacts WHERE id=?`).get(id);
    if (!row) return null;
    return { ...row, metadata: parseJson(row.metadataJson), metadataJson: undefined };
  }
  listArtifacts(projectId) { return this.db.prepare("SELECT id FROM project_artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 500").all(projectId).map((row) => this.getArtifact(row.id)); }

  async ingest(projectId, input = {}) {
    if (!this.get(projectId)) throw fail("Project not found.", 404, "PROJECT_NOT_FOUND");
    const title = safeName(input.title); if (title.length < 2) throw fail("A source title is required.");
    const declaredKind = String(input.kind || "text").toLowerCase();
    let buffer;
    if (typeof input.text === "string") buffer = Buffer.from(input.text, "utf8");
    else {
      if (typeof input.dataBase64 !== "string" || input.dataBase64.length > Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 16) throw fail("Import data is missing or too large.", 413, "IMPORT_TOO_LARGE");
      buffer = Buffer.from(input.dataBase64, "base64");
    }
    if (!buffer.length || buffer.length > MAX_IMPORT_BYTES) throw fail("Import must be between 1 byte and 10 MB.", 413, "IMPORT_TOO_LARGE");
    let kind = declaredKind; let mimeType = bounded(input.mimeType, 100) || "text/plain"; let chunks = []; let status = "indexed"; let metadata = {};
    if (["text", "markdown", "source"].includes(kind)) {
      if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) throw fail("Text sources must be UTF-8 text no larger than 2 MB.", 413, "TEXT_IMPORT_INVALID");
      mimeType = kind === "markdown" ? "text/markdown" : "text/plain";
      chunks = chunkText(buffer.toString("utf8"), kind === "markdown" ? "markdown" : "source");
    } else if (kind === "pdf") {
      mimeType = "application/pdf";
      chunks = extractPdfText(buffer);
    } else if (kind === "image") {
      metadata = inspectImage(buffer); mimeType = metadata.mimeType; status = "metadata-only";
      const caption = bounded(input.caption, 4000);
      chunks = caption ? [{ locator: "user caption", content: caption }] : [{ locator: "image metadata", content: `${title}: ${metadata.format} image${metadata.width ? `, ${metadata.width}x${metadata.height}` : ""}. No OCR or visual description was generated.` }];
    } else throw fail("Supported source kinds are text, markdown, source, PDF, and image.", 415, "SOURCE_TYPE_UNSUPPORTED");
    if (!chunks.length) throw fail("The source produced no indexable content.", 422, "SOURCE_EMPTY");
    const artifact = await this.#storeArtifact(projectId, { runId: input.runId || null, title, kind, mimeType, buffer, sourcePath: input.sourcePath || "", metadata });
    const sourceId = crypto.randomUUID(); const stamp = now(); const contentHash = hash(buffer);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO project_knowledge_sources(id,project_id,artifact_id,title,kind,status,source_path,content_hash,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sourceId, projectId, artifact.id, title, kind, status, bounded(input.sourcePath, 500), contentHash, "", stamp, stamp);
      const insert = this.db.prepare("INSERT INTO project_knowledge_chunks(id,source_id,position,locator,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?)");
      chunks.slice(0, MAX_CHUNKS).forEach((chunk, index) => insert.run(crypto.randomUUID(), sourceId, index, bounded(chunk.locator, 300), chunk.content.slice(0, 8_000), hash(chunk.content), stamp));
    })();
    this.database.audit("project.knowledge-ingested", `Indexed ${title}`, { entityType: "project-knowledge-source", entityId: sourceId,
      metadata: { projectId, kind, status, chunks: Math.min(chunks.length, MAX_CHUNKS), bytes: buffer.length } });
    return this.getSource(sourceId);
  }

  getSource(id) {
    const row = this.db.prepare(`SELECT id,project_id AS projectId,artifact_id AS artifactId,title,kind,status,source_path AS sourcePath,
      content_hash AS contentHash,error,created_at AS createdAt,updated_at AS updatedAt FROM project_knowledge_sources WHERE id=?`).get(id);
    if (!row) return null;
    return { ...row, chunks: this.db.prepare("SELECT COUNT(*) count FROM project_knowledge_chunks WHERE source_id=?").get(id).count };
  }
  listSources(projectId) { return this.db.prepare("SELECT id FROM project_knowledge_sources WHERE project_id=? AND status!='deleted' ORDER BY updated_at DESC LIMIT 500").all(projectId).map((row) => this.getSource(row.id)); }
  deleteSource(projectId, id) {
    const source = this.getSource(id); if (!source || source.projectId !== projectId) throw fail("Knowledge source not found.", 404, "SOURCE_NOT_FOUND");
    this.db.prepare("UPDATE project_knowledge_sources SET status='deleted',updated_at=? WHERE id=?").run(now(), id);
    this.db.prepare("DELETE FROM project_knowledge_chunks WHERE source_id=?").run(id);
    return { ok: true };
  }

  search(projectId, query, limit = 8) {
    if (!this.get(projectId) || !String(query).trim()) return [];
    const rows = this.db.prepare(`SELECT c.id,c.locator,c.content,s.id AS sourceId,s.title,s.kind,s.source_path AS sourcePath,s.artifact_id AS artifactId
      FROM project_knowledge_chunks c JOIN project_knowledge_sources s ON s.id=c.source_id
      WHERE s.project_id=? AND s.status IN ('indexed','metadata-only') ORDER BY s.updated_at DESC,c.position LIMIT 5000`).all(projectId);
    return rows.map((row) => ({ ...row, projectId, domain: "Project", score: scoreText(query, row.title, row.locator, row.content),
      citation: { sourceId: row.sourceId, title: row.title, path: row.sourcePath, locator: row.locator, artifactId: row.artifactId } }))
      .filter((row) => row.score > 0).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
  }

  async syncFiles(projectId) {
    const root = await this.rootFor(projectId); const found = []; let totalBytes = 0;
    const walk = async (absolute, relative = "", depth = 0) => {
      if (depth > 8 || found.length >= MAX_INDEX_FILES || totalBytes >= MAX_INDEX_BYTES) return;
      const entries = await fsp.readdir(absolute, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (found.length >= MAX_INDEX_FILES || totalBytes >= MAX_INDEX_BYTES) break;
        const childRelative = path.join(relative, entry.name);
        if (isDenied(childRelative) || entry.isSymbolicLink()) continue;
        const child = path.join(absolute, entry.name);
        if (entry.isDirectory()) await walk(child, childRelative, depth + 1);
        else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          const stat = await fsp.stat(child); if (stat.size > 1024 * 1024 || totalBytes + stat.size > MAX_INDEX_BYTES) continue;
          const data = await fsp.readFile(child); if (data.includes(0)) continue;
          totalBytes += stat.size;
          found.push({ relativePath: childRelative.replaceAll("\\", "/"), sizeBytes: stat.size, sha256: hash(data), modifiedAt: stat.mtime.toISOString(),
            kind: path.extname(entry.name).toLowerCase() === ".md" ? "markdown" : "source", data });
        }
      }
    };
    await walk(root);
    const stamp = now();
    const previous = new Map(this.db.prepare("SELECT relative_path relativePath,sha256 FROM project_files WHERE project_id=?").all(projectId).map((row) => [row.relativePath, row.sha256]));
    for (const file of found) {
      this.db.prepare(`INSERT INTO project_files(project_id,relative_path,size_bytes,sha256,modified_at,kind,indexed_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(project_id,relative_path) DO UPDATE SET size_bytes=excluded.size_bytes,sha256=excluded.sha256,modified_at=excluded.modified_at,kind=excluded.kind,indexed_at=excluded.indexed_at`)
        .run(projectId, file.relativePath, file.sizeBytes, file.sha256, file.modifiedAt, file.kind, stamp);
      if (previous.get(file.relativePath) === file.sha256) continue;
      const old = this.db.prepare("SELECT id FROM project_knowledge_sources WHERE project_id=? AND source_path=? AND status!='deleted'").all(projectId, file.relativePath);
      for (const row of old) this.deleteSource(projectId, row.id);
      await this.ingest(projectId, { title: path.basename(file.relativePath), kind: file.kind, text: file.data.toString("utf8"), sourcePath: file.relativePath });
    }
    const active = new Set(found.map((file) => file.relativePath));
    for (const relativePath of previous.keys()) if (!active.has(relativePath)) {
      this.db.prepare("DELETE FROM project_files WHERE project_id=? AND relative_path=?").run(projectId, relativePath);
      this.db.prepare("UPDATE project_knowledge_sources SET status='deleted',updated_at=? WHERE project_id=? AND source_path=?").run(stamp, projectId, relativePath);
    }
    this.database.audit("project.files-synced", `Indexed ${found.length} project files`, { entityType: "project", entityId: projectId,
      metadata: { files: found.length, bytes: totalBytes, truncated: found.length >= MAX_INDEX_FILES || totalBytes >= MAX_INDEX_BYTES } });
    return { projectId, files: found.length, bytes: totalBytes, limit: { files: MAX_INDEX_FILES, bytes: MAX_INDEX_BYTES } };
  }

  listFiles(projectId, limit = 500) { return this.db.prepare(`SELECT relative_path AS path,size_bytes AS sizeBytes,sha256,modified_at AS modifiedAt,kind,indexed_at AS indexedAt
    FROM project_files WHERE project_id=? ORDER BY relative_path LIMIT ?`).all(projectId, Math.max(1, Math.min(500, Number(limit) || 500))); }
}
