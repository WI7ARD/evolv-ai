import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// The Evolv sandbox: a place to do the work before doing it for real.
//
// A session mirrors the project's text files into a private directory. Edits
// land there, validation runs there, and the real workspace is untouched until
// a promotion is explicitly approved. A simulation that fails is discarded and
// costs the project nothing, which is the entire point — the sandbox is a
// safety layer, not a preview.
//
// Two invariants carry the safety claim:
//
//   1. Only `promote` writes to the real workspace, and it refuses if a file
//      changed underneath the simulation. Work done against a stale copy is
//      never silently applied.
//   2. Validation executes inside the sandbox with the same allowlist and
//      scrubbed environment the approved-check tool uses. It cannot reach the
//      real project, so running it needs no separate approval — the approval
//      belongs to promotion.

const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 24_000;
const DENIED_SEGMENTS = new Set([".git", "node_modules", "data", "backups", ".obsidian", ".trash", "dist", "out"]);
const SECRET_NAMES = [/^\.env(?:\.|$)/i, /credential/i, /secret/i, /private[-_. ]?key/i, /\.pem$/i, /\.pfx$/i, /\.key$/i, /\.p12$/i];
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".css", ".html",
  ".htm", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".ps1", ".yaml", ".yml",
  ".toml", ".ini", ".sql", ".xml", ".csv"
]);
// Mirrors lib/engineering-actions.mjs. Validation may only run checks; it may
// never install, publish, or otherwise reach the network.
const SAFE_SCRIPT = /^(?:test(?::[a-z0-9._-]+)?|lint(?::[a-z0-9._-]+)?|check(?::[a-z0-9._-]+)?|typecheck|build(?::[a-z0-9._-]+)?|format:check)$/i;

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fail(message, status = 400, code = "SANDBOX_INVALID") {
  return Object.assign(new Error(message), { status, code });
}
function cap(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[output truncated at ${limit} characters]` : text;
}

export function isDeniedPath(relative) {
  const segments = String(relative).split(/[\\/]/).filter(Boolean);
  if (!segments.length) return true;
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return DENIED_SEGMENTS.has(lower) || lower.startsWith("out-") || lower.startsWith("dist-")
      || segment.startsWith(".") || SECRET_NAMES.some((pattern) => pattern.test(segment));
  });
}

// Contains a project-relative path inside a root. Rejects absolute paths,
// traversal, and anything the denial list covers.
function containedPath(root, relative) {
  const raw = String(relative || "").replaceAll("\\", "/").trim();
  if (!raw || raw.includes("\0") || path.isAbsolute(raw)) throw fail("Use a project-relative path.", 400, "PATH_DENIED");
  const resolved = path.resolve(root, raw);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw fail("Path leaves the sandbox.", 400, "PATH_DENIED");
  const normalized = path.relative(root, resolved).replaceAll("\\", "/");
  if (isDeniedPath(normalized)) throw fail("That path is protected and cannot be simulated.", 400, "PATH_DENIED");
  if (!TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    throw fail("Only text files can be simulated.", 400, "PATH_DENIED");
  }
  return { absolute: resolved, relative: normalized };
}

export class SandboxService {
  constructor({ database, projectService, approvalService = null, sandboxRoot }) {
    this.database = database;
    this.db = database.raw;
    this.projectService = projectService;
    this.approvalService = approvalService;
    this.sandboxRoot = sandboxRoot;
  }

  #session(id) {
    const row = this.db.prepare(`SELECT id,project_id projectId,agent_run_id agentRunId,conversation_id conversationId,
      root_path rootPath,objective,state,file_count fileCount,byte_count byteCount,truncated,error,
      created_at createdAt,closed_at closedAt FROM sandbox_sessions WHERE id=?`).get(id);
    if (!row) throw fail("Sandbox session not found.", 404, "SANDBOX_NOT_FOUND");
    return { ...row, truncated: Boolean(row.truncated) };
  }

  #edits(sessionId) {
    return this.db.prepare(`SELECT id,relative_path relativePath,operation,base_sha256 baseSha256,
      next_sha256 nextSha256,bytes,summary,created_at createdAt
      FROM sandbox_edits WHERE session_id=? ORDER BY relative_path`).all(sessionId);
  }

  #validations(sessionId) {
    return this.db.prepare(`SELECT id,kind,passed,exit_code exitCode,summary,output,duration_ms durationMs,created_at createdAt
      FROM sandbox_validations WHERE session_id=? ORDER BY created_at`).all(sessionId)
      .map((row) => ({ ...row, passed: Boolean(row.passed) }));
  }

  get(id) {
    const session = this.#session(id);
    return { ...session, edits: this.#edits(id), validations: this.#validations(id) };
  }

  list({ limit = 50 } = {}) {
    return this.db.prepare(`SELECT id,project_id projectId,state,objective,file_count fileCount,
      created_at createdAt,closed_at closedAt FROM sandbox_sessions ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(200, limit)));
  }

  // Mirrors the project's text files into a private directory. Bounded the
  // same way project indexing is, and excluding the same protected paths, so
  // a sandbox can never carry secrets that the project tools already refuse.
  async open({ projectId, objective = "", agentRunId = null, conversationId = null }) {
    const projectRoot = await this.projectService.rootFor(projectId);
    const id = crypto.randomUUID();
    const root = path.join(this.sandboxRoot, id);
    await fsp.mkdir(root, { recursive: true });

    let fileCount = 0;
    let byteCount = 0;
    let truncated = false;
    const walk = async (absolute, relative, depth) => {
      if (depth > 8 || fileCount >= MAX_FILES || byteCount >= MAX_BYTES) { truncated = true; return; }
      const entries = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (fileCount >= MAX_FILES || byteCount >= MAX_BYTES) { truncated = true; break; }
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (isDeniedPath(childRelative) || entry.isSymbolicLink()) continue;
        const childAbsolute = path.join(absolute, entry.name);
        if (entry.isDirectory()) { await walk(childAbsolute, childRelative, depth + 1); continue; }
        if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await fsp.stat(childAbsolute).catch(() => null);
        if (!info || info.size > MAX_FILE_BYTES) continue;
        const target = path.join(root, childRelative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(childAbsolute, target);
        fileCount += 1;
        byteCount += info.size;
      }
    };
    await walk(projectRoot, "", 0);

    this.db.prepare(`INSERT INTO sandbox_sessions(id,project_id,agent_run_id,conversation_id,root_path,objective,
      state,file_count,byte_count,truncated,created_at) VALUES (?,?,?,?,?,?,'open',?,?,?,?)`)
      .run(id, projectId, agentRunId, conversationId, root, String(objective || "").slice(0, 2000),
        fileCount, byteCount, truncated ? 1 : 0, now());
    this.database.audit("sandbox.opened", `Opened a sandbox with ${fileCount} file(s)`, {
      entityType: "sandbox", entityId: id, metadata: { projectId, fileCount, truncated }
    });
    return this.get(id);
  }

  // Writes inside the sandbox only. Records the real workspace's hash at this
  // moment so promotion can detect that the ground moved underneath us.
  async applyEdit(sessionId, { path: relativePath, content, summary = "" }) {
    const session = this.#session(sessionId);
    if (session.state !== "open") throw fail(`This sandbox is ${session.state} and no longer accepts edits.`, 409, "SANDBOX_CLOSED");
    if (typeof content !== "string") throw fail("content must be a string.", 400, "INVALID_ARGUMENT");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw fail("Simulated files are limited to 2 MB.", 413, "OUTPUT_LIMIT");

    const inSandbox = containedPath(session.rootPath, relativePath);
    const projectRoot = await this.projectService.rootFor(session.projectId);
    const inProject = containedPath(projectRoot, relativePath);

    const original = await fsp.readFile(inProject.absolute, "utf8").catch(() => null);
    await fsp.mkdir(path.dirname(inSandbox.absolute), { recursive: true });
    await fsp.writeFile(inSandbox.absolute, content, "utf8");

    this.db.prepare(`INSERT INTO sandbox_edits(id,session_id,relative_path,operation,base_sha256,next_sha256,bytes,summary,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,relative_path) DO UPDATE SET next_sha256=excluded.next_sha256,
        bytes=excluded.bytes, summary=excluded.summary`)
      .run(crypto.randomUUID(), sessionId, inSandbox.relative, original === null ? "create" : "edit",
        original === null ? null : sha256(original), sha256(content), Buffer.byteLength(content),
        String(summary || "").slice(0, 500), now());
    return this.get(sessionId);
  }

  #recordValidation(sessionId, kind, result) {
    this.db.prepare(`INSERT INTO sandbox_validations(id,session_id,kind,passed,exit_code,summary,output,duration_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), sessionId, kind, result.passed ? 1 : 0, result.exitCode ?? null,
        String(result.summary || "").slice(0, 500), cap(result.output), result.durationMs || 0, now());
  }

  #run(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(command, args, {
        cwd, shell: false, windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/i.test(key)))
      });
      let output = "";
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { child.kill(); finish({ passed: false, exitCode: null, output, summary: "Timed out.", durationMs: Date.now() - started }); }, timeoutMs);
      child.stdout.on("data", (chunk) => { output = cap(output + chunk); });
      child.stderr.on("data", (chunk) => { output = cap(output + chunk); });
      child.on("error", (error) => finish({ passed: false, exitCode: null, output, summary: `Could not start: ${error.message}`, durationMs: Date.now() - started }));
      child.on("close", (code) => finish({
        passed: code === 0, exitCode: code, output,
        summary: code === 0 ? "Passed." : `Exited with code ${code}.`, durationMs: Date.now() - started
      }));
    });
  }

  // Syntax-checks every simulated JavaScript file, then runs the requested
  // package scripts. All of it inside the sandbox, none of it able to reach
  // the real workspace.
  async validate(sessionId, { scripts = [], timeoutMs = 120_000 } = {}) {
    const session = this.#session(sessionId);
    if (!["open", "validated", "failed"].includes(session.state)) {
      throw fail(`This sandbox is ${session.state} and cannot be validated.`, 409, "SANDBOX_CLOSED");
    }
    const requested = (Array.isArray(scripts) ? scripts : []).map(String).slice(0, 4);
    for (const script of requested) {
      if (!SAFE_SCRIPT.test(script)) throw fail(`Only test, lint, check, typecheck, build, or format:check scripts may run. Rejected: ${script}`, 400, "COMMAND_DENIED");
    }
    this.db.prepare("UPDATE sandbox_sessions SET state='validating' WHERE id=?").run(sessionId);

    let allPassed = true;
    for (const edit of this.#edits(sessionId)) {
      if (![".js", ".mjs", ".cjs"].includes(path.extname(edit.relativePath).toLowerCase())) continue;
      const result = await this.#run(process.execPath, ["--check", edit.relativePath], session.rootPath, 15_000);
      this.#recordValidation(sessionId, `syntax:${edit.relativePath}`, result);
      if (!result.passed) allPassed = false;
    }
    for (const script of requested) {
      // Same shell-free invocation the approved-check tool uses.
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = await this.#run(npm, ["run", script], session.rootPath, timeoutMs);
      this.#recordValidation(sessionId, `script:${script}`, result);
      if (!result.passed) allPassed = false;
    }

    this.db.prepare("UPDATE sandbox_sessions SET state=? WHERE id=?").run(allPassed ? "validated" : "failed", sessionId);
    this.database.audit(allPassed ? "sandbox.validated" : "sandbox.validation-failed",
      `Sandbox validation ${allPassed ? "passed" : "failed"}`, { entityType: "sandbox", entityId: sessionId });
    return this.get(sessionId);
  }

  // Requests promotion. Nothing is written here — this only raises the
  // approval that a human has to decide.
  requestPromotion(sessionId) {
    const session = this.get(sessionId);
    if (!session.edits.length) throw fail("This sandbox changed nothing to promote.", 409, "SANDBOX_EMPTY");
    if (session.state === "promoted") throw fail("This sandbox was already promoted.", 409, "SANDBOX_CLOSED");
    if (session.state === "discarded") throw fail("This sandbox was discarded.", 409, "SANDBOX_CLOSED");
    if (!this.approvalService) return { approvalRequired: false, session };
    const request = this.approvalService.create({
      kind: "sandbox-promotion",
      risk: "approval-write",
      resourceType: "sandbox",
      resourceId: sessionId,
      agentRunId: session.agentRunId,
      conversationId: session.conversationId,
      summary: `Apply ${session.edits.length} simulated file change(s) to the project`,
      after: {
        files: session.edits.map((edit) => ({ path: edit.relativePath, operation: edit.operation, bytes: edit.bytes })),
        validations: session.validations.map((item) => ({ kind: item.kind, passed: item.passed })),
        validated: session.state === "validated"
      },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
    });
    return { approvalRequired: true, approvalId: request.id, session };
  }

  // The only path that writes to the real workspace. Refuses outright if any
  // file moved since the simulation read it, so approved work is never
  // applied on top of someone else's change.
  async promote(sessionId, { requireValidation = true } = {}) {
    const session = this.get(sessionId);
    if (session.state === "promoted") throw fail("This sandbox was already promoted.", 409, "SANDBOX_CLOSED");
    if (session.state === "discarded") throw fail("This sandbox was discarded.", 409, "SANDBOX_CLOSED");
    if (!session.edits.length) throw fail("This sandbox changed nothing to promote.", 409, "SANDBOX_EMPTY");
    if (requireValidation && session.state !== "validated") {
      throw fail("Validate the sandbox before promoting it.", 409, "SANDBOX_NOT_VALIDATED");
    }
    const projectRoot = await this.projectService.rootFor(session.projectId);

    // Verify every target first; a partial promotion is worse than none.
    const staged = [];
    for (const edit of session.edits) {
      const target = containedPath(projectRoot, edit.relativePath);
      const current = await fsp.readFile(target.absolute, "utf8").catch(() => null);
      const currentHash = current === null ? null : sha256(current);
      if (currentHash !== edit.baseSha256) {
        throw fail(`${edit.relativePath} changed since the simulation started. Re-run it against the current file.`, 409, "SANDBOX_STALE");
      }
      const source = path.join(session.rootPath, edit.relativePath);
      const content = await fsp.readFile(source, "utf8");
      if (sha256(content) !== edit.nextSha256) throw fail(`${edit.relativePath} changed inside the sandbox after it was recorded.`, 409, "SANDBOX_STALE");
      staged.push({ target: target.absolute, content, relativePath: edit.relativePath });
    }

    const written = [];
    for (const item of staged) {
      const temporary = `${item.target}.evolv-${crypto.randomUUID()}.tmp`;
      await fsp.mkdir(path.dirname(item.target), { recursive: true });
      await fsp.writeFile(temporary, item.content, { encoding: "utf8", flag: "wx" });
      await fsp.rename(temporary, item.target);
      written.push(item.relativePath);
    }

    this.db.prepare("UPDATE sandbox_sessions SET state='promoted', closed_at=? WHERE id=?").run(now(), sessionId);
    this.database.audit("sandbox.promoted", `Applied ${written.length} simulated change(s) to the project`, {
      entityType: "sandbox", entityId: sessionId, metadata: { projectId: session.projectId, files: written }
    });
    return { ...this.get(sessionId), applied: written };
  }

  async discard(sessionId, reason = "") {
    const session = this.#session(sessionId);
    await fsp.rm(session.rootPath, { recursive: true, force: true }).catch(() => {});
    if (!["promoted", "discarded"].includes(session.state)) {
      this.db.prepare("UPDATE sandbox_sessions SET state='discarded', closed_at=?, error=? WHERE id=?")
        .run(now(), String(reason || "").slice(0, 500), sessionId);
    }
    this.database.audit("sandbox.discarded", "Discarded a sandbox without touching the project", {
      entityType: "sandbox", entityId: sessionId
    });
    return this.get(sessionId);
  }

  // The object view the brief's world layer would render: every simulated file
  // as an object with its state and available actions. Deliberately derived
  // from real session state — there is nothing here that did not happen.
  objects(sessionId) {
    const session = this.get(sessionId);
    const byPath = new Map(session.edits.map((edit) => [edit.relativePath, edit]));
    const validationFor = (relativePath) => session.validations
      .filter((item) => item.kind === `syntax:${relativePath}`)
      .map((item) => ({ kind: item.kind, passed: item.passed }));
    return {
      sessionId,
      state: session.state,
      objective: session.objective,
      objects: [
        { id: "project", type: "project", label: session.projectId, actions: ["open-sandbox"] },
        ...session.edits.map((edit) => ({
          id: `file:${edit.relativePath}`,
          type: "file",
          label: edit.relativePath,
          operation: edit.operation,
          bytes: edit.bytes,
          validations: validationFor(edit.relativePath),
          actions: session.state === "open" ? ["edit", "discard"] : ["inspect"]
        })),
        ...session.validations.filter((item) => item.kind.startsWith("script:")).map((item) => ({
          id: `check:${item.kind}`, type: "check", label: item.kind.slice(7),
          passed: item.passed, actions: ["inspect"]
        }))
      ],
      // What the agent may do next, given real state — not a fictional world.
      available: session.state === "open" ? ["apply-edit", "validate", "discard"]
        : session.state === "validated" ? ["promote", "discard"]
        : session.state === "failed" ? ["apply-edit", "validate", "discard"]
        : [],
      untouched: !["promoted"].includes(session.state),
      fileCount: session.fileCount,
      truncated: session.truncated
    };
  }
}
