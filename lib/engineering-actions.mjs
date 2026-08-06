import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_EDIT_BYTES = 512 * 1024;
const MAX_RESEARCH_BYTES = 256 * 1024;
const MAX_RESULT_CHARS = 24_000;
const DENIED_SEGMENTS = new Set([".git", "node_modules", "data", "backups", ".agents", ".codex"]);
const DENIED_NAMES = [/^\.env(?:\.|$)/i, /credential/i, /secret/i, /private[-_.]?key/i, /id_rsa/i, /id_ed25519/i, /\.(?:pem|pfx|p12|key|crt|cer)$/i];
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".jsonl", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".py", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".rb", ".php", ".swift", ".kt", ".gradle", ".properties"]);
const SAFE_SCRIPT = /^(?:test(?::[a-z0-9._-]+)?|lint(?::[a-z0-9._-]+)?|check(?::[a-z0-9._-]+)?|typecheck|build(?::[a-z0-9._-]+)?|format:check)$/i;

function actionError(message, status = 400, code = "ENGINEERING_ACTION_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cap(value, limit = MAX_RESULT_CHARS) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[output truncated at ${limit} characters]` : text;
}

function deniedPath(relative) {
  const segments = String(relative).split(/[\\/]/).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    return DENIED_SEGMENTS.has(lower) || lower.startsWith("out-") || lower.startsWith("dist-")
      || DENIED_NAMES.some((pattern) => pattern.test(segment));
  });
}

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

function cleanResearchText(body, contentType) {
  if (contentType.includes("application/json")) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { throw actionError("Research endpoint returned malformed JSON.", 502, "MALFORMED_RESPONSE"); }
  }
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

export class EngineeringActionService {
  constructor({ database, workspaceRoot, fetchImpl = globalThis.fetch, lookup = dns.lookup, approvalService = null, projectService = null }) {
    this.database = database;
    this.root = path.resolve(workspaceRoot);
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.approvalService = approvalService;
    this.projectService = projectService;
    // Tables come from the recorded schema in lib/schema.mjs.
  }

  async actionRoot(input = {}) {
    if (this.projectService) return this.projectService.rootFor(input.projectId);
    return input.projectRoot ? path.resolve(input.projectRoot) : this.root;
  }

  async safePath(input, { allowMissing = false, projectRoot = "" } = {}) {
    const allowedRoot = projectRoot ? path.resolve(projectRoot) : this.root;
    const allowedStat = await fs.stat(allowedRoot).catch(() => null);
    if (!allowedStat?.isDirectory()) throw actionError("The selected project folder is unavailable.", 409, "PROJECT_UNAVAILABLE");
    const raw = String(input || "");
    if (!raw || raw.includes("\0") || path.isAbsolute(raw)) throw actionError("Use a project-relative path.", 400, "PATH_DENIED");
    const resolved = path.resolve(allowedRoot, raw);
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw actionError("Path leaves the project.", 400, "PATH_DENIED");
    const relative = path.relative(allowedRoot, resolved).replaceAll("\\", "/");
    if (!relative || deniedPath(relative) || !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw actionError("That project path is protected or is not a supported text file.", 400, "PATH_DENIED");
    const parentReal = await fs.realpath(path.dirname(resolved)).catch(() => null);
    const rootReal = await fs.realpath(allowedRoot);
    if (!parentReal || (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`))) throw actionError("The parent directory is missing or leaves the project.", 400, "PATH_DENIED");
    try {
      const real = await fs.realpath(resolved);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) throw actionError("Symlink leaves the project.", 400, "PATH_DENIED");
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > MAX_EDIT_BYTES) throw actionError("Project edit target must be a text file no larger than 512 KB.", 400, "OUTPUT_LIMIT");
      return { absolute: real, relative, exists: true };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!allowMissing) throw actionError("Project file does not exist.", 404, "NOT_FOUND");
      return { absolute: resolved, relative, exists: false };
    }
  }

  save(runId, kind, payload) {
    const id = crypto.randomUUID();
    this.database.raw.prepare("INSERT INTO engineering_actions(id,run_id,kind,status,payload_json,created_at) VALUES (?,?,?,'pending',?,?)")
      .run(id, runId, kind, JSON.stringify(payload), new Date().toISOString());
    if (this.approvalService) {
      const toolRun = this.database.raw.prepare("SELECT conversation_id AS conversationId,message_id AS messageId FROM tool_runs WHERE id=?").get(runId);
      const message = toolRun?.messageId ? this.database.raw.prepare("SELECT metadata_json FROM messages WHERE id=?").get(toolRun.messageId) : null;
      let metadata = {}; try { metadata = JSON.parse(message?.metadata_json || "{}"); } catch {}
      this.approvalService.create({
        kind,
        resourceType: "engineering-action",
        resourceId: id,
        toolRunId: runId,
        conversationId: toolRun?.conversationId || null,
        agentRunId: metadata.agentRunId || null,
        summary: payload.preview?.summary || `Approve ${kind}`,
        before: payload.preview?.beforeSha256 ? { sha256: payload.preview.beforeSha256, lines: payload.preview.beforeLines } : {},
        after: payload.preview || {},
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
      });
    }
    return { actionId: id, approvalRequired: true, kind, preview: payload.preview };
  }

  async proposeEdit(runId, input) {
    const projectRoot = await this.actionRoot(input);
    const target = await this.safePath(input.path, { allowMissing: Boolean(input.create), projectRoot });
    const original = target.exists ? await fs.readFile(target.absolute, "utf8") : "";
    let next;
    if (input.create) {
      if (target.exists) throw actionError("The create target already exists.", 409, "ALREADY_EXISTS");
      next = String(input.content || "");
    } else {
      const find = String(input.find ?? "");
      if (!find) throw actionError("find is required for an edit.", 400, "INVALID_ARGUMENT");
      const occurrences = original.split(find).length - 1;
      if (!occurrences) throw actionError("The exact text to replace was not found.", 409, "STALE_EDIT");
      if (!input.replace_all && occurrences !== 1) throw actionError("The text occurs more than once; narrow the edit or explicitly request replace_all.", 409, "AMBIGUOUS_EDIT");
      next = input.replace_all ? original.split(find).join(String(input.replace ?? "")) : original.replace(find, String(input.replace ?? ""));
    }
    if (Buffer.byteLength(next) > MAX_EDIT_BYTES) throw actionError("Proposed file is larger than 512 KB.", 413, "OUTPUT_LIMIT");
    const preview = {
      path: target.relative,
      operation: input.create ? "create" : "edit",
      summary: String(input.summary || "").slice(0, 500),
      beforeSha256: target.exists ? hash(original) : null,
      afterSha256: hash(next),
      beforeLines: original ? original.split(/\r?\n/).length : 0,
      afterLines: next.split(/\r?\n/).length,
      removed: input.create ? "" : cap(String(input.find), 2_000),
      added: input.create ? cap(next, 4_000) : cap(String(input.replace ?? ""), 2_000)
    };
    return this.save(runId, input.create ? "workspace-create" : "workspace-edit", {
      root: projectRoot, path: target.relative, originalHash: target.exists ? hash(original) : null, next, preview
    });
  }

  async proposeCheck(runId, input) {
    const projectRoot = await this.actionRoot(input);
    const kind = String(input.check || "");
    let command;
    if (kind === "git-status") command = { executable: "git", args: ["status", "--short"] };
    else if (kind === "git-diff") command = { executable: "git", args: ["diff", "--", "."] };
    else if (kind === "node-test") {
      const file = String(input.path || "").replaceAll("\\", "/");
      if (!file || file.startsWith("/") || file.includes("..") || !/\.(?:m?js|cjs|ts)$/i.test(file)) throw actionError("node-test needs a safe project-relative test file.", 400, "INVALID_ARGUMENT");
      command = { executable: "node", args: ["--test", file] };
    } else if (kind === "npm-script") {
      const script = String(input.script || "");
      if (!SAFE_SCRIPT.test(script)) throw actionError("Only test, lint, check, typecheck, build, or format:check scripts are permitted.", 400, "COMMAND_DENIED");
      command = { executable: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script] };
    } else throw actionError("Unsupported engineering check.", 400, "COMMAND_DENIED");
    return this.save(runId, "engineering-check", {
      root: projectRoot, command,
      timeoutMs: Math.min(300_000, Math.max(5_000, Number(input.timeout_ms) || 120_000)),
      preview: { command: [command.executable, ...command.args].join(" "), summary: String(input.summary || "").slice(0, 500) }
    });
  }

  async validateResearchUrl(value) {
    let url;
    try { url = new URL(String(value)); } catch { throw actionError("Research URL is invalid.", 400, "NETWORK_DENIED"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw actionError("Research requires credential-free HTTPS on the standard port.", 400, "NETWORK_DENIED");
    if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase()) || net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw actionError("Local and private destinations are blocked.", 400, "NETWORK_DENIED");
    const addresses = await this.lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw actionError("The destination could not be verified as a public internet host.", 400, "NETWORK_DENIED");
    return url;
  }

  async proposeResearch(runId, input) {
    const url = await this.validateResearchUrl(input.url);
    return this.save(runId, "web-research", {
      url: url.href,
      preview: { url: url.href, purpose: String(input.purpose || "").slice(0, 500), sendsPrompt: false, maxBytes: MAX_RESEARCH_BYTES }
    });
  }

  getByRun(runId) {
    const row = this.database.raw.prepare("SELECT * FROM engineering_actions WHERE run_id=?").get(runId);
    if (!row) return null;
    return { id: row.id, runId: row.run_id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload_json), result: JSON.parse(row.result_json || "{}"), error: row.error || "" };
  }

  async runCommand(command, timeoutMs, projectRoot = this.root) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: projectRoot, shell: false, windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC)$/i.test(key)))
      });
      let stdout = ""; let stderr = ""; let settled = false;
      const timer = setTimeout(() => { child.kill(); reject(actionError("Approved engineering check timed out.", 504, "TIMEOUT")); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout = cap(stdout + chunk); });
      child.stderr.on("data", (chunk) => { stderr = cap(stderr + chunk); });
      child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(actionError(`Could not start approved check: ${error.message}`, 500, "COMMAND_UNAVAILABLE")); } });
      child.on("close", (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ exitCode: code, signal: signal || null, passed: code === 0, stdout, stderr }); } });
    });
  }

  async executeResearch(urlValue) {
    const url = await this.validateResearchUrl(urlValue);
    const response = await this.fetchImpl(url, { method: "GET", redirect: "error", headers: { accept: "text/html, text/plain, application/json" } });
    if (response.status >= 300 && response.status < 400) throw actionError("Research redirects are blocked.", 502, "NETWORK_DENIED");
    if (!response.ok) throw actionError(`Research request returned HTTP ${response.status}.`, 502, "UPSTREAM_ERROR");
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/") && !type.includes("application/json")) throw actionError("Research response is not text or JSON.", 415, "CONTENT_TYPE_DENIED");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_RESEARCH_BYTES) throw actionError("Research response is too large.", 413, "OUTPUT_LIMIT");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESEARCH_BYTES) throw actionError("Research response is too large.", 413, "OUTPUT_LIMIT");
    return { url: url.href, contentType: type.split(";")[0], text: cap(cleanResearchText(buffer.toString("utf8"), type)), untrusted: true };
  }

  async decide(runId, decision) {
    const action = this.getByRun(runId);
    if (!action || action.status !== "pending") throw actionError("Pending engineering action not found.", 404, "NOT_FOUND");
    const approval = this.approvalService?.getByResource("engineering-action", action.id);
    if (decision === "rejected") {
      if (approval?.status === "pending") this.approvalService.decide(approval.id, "rejected");
      this.database.raw.prepare("UPDATE engineering_actions SET status='rejected',result_json=?,decided_at=? WHERE id=?")
        .run(JSON.stringify({ approved: false }), new Date().toISOString(), action.id);
      return { actionId: action.id, kind: action.kind, decision, approved: false };
    }
    if (approval?.status === "pending") this.approvalService.decide(approval.id, "approved");
    let result;
    try {
      if (["workspace-edit", "workspace-create"].includes(action.kind)) {
        const target = await this.safePath(action.payload.path, { allowMissing: action.kind === "workspace-create", projectRoot: action.payload.root });
        const current = target.exists ? await fs.readFile(target.absolute, "utf8") : "";
        if ((target.exists ? hash(current) : null) !== action.payload.originalHash) throw actionError("The file changed after review; approval was cancelled to prevent overwriting newer work.", 409, "STALE_EDIT");
        const temporary = `${target.absolute}.evolv-${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, action.payload.next, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporary, target.absolute);
        result = { path: action.payload.path, operation: action.kind === "workspace-create" ? "created" : "edited", sha256: hash(action.payload.next), bytes: Buffer.byteLength(action.payload.next) };
      } else if (action.kind === "engineering-check") result = await this.runCommand(action.payload.command, action.payload.timeoutMs, action.payload.root);
      else if (action.kind === "web-research") result = await this.executeResearch(action.payload.url);
      else throw actionError("Unknown engineering action kind.", 409, "ACTION_DENIED");
      this.database.raw.prepare("UPDATE engineering_actions SET status='approved',result_json=?,error='',decided_at=? WHERE id=?")
        .run(JSON.stringify(result), new Date().toISOString(), action.id);
      if (approval) this.approvalService.markExecuted(approval.id, result);
      return { actionId: action.id, kind: action.kind, decision, approved: true, result };
    } catch (error) {
      this.database.raw.prepare("UPDATE engineering_actions SET status='failed',error=?,decided_at=? WHERE id=?")
        .run(String(error.message || error).slice(0, 2000), new Date().toISOString(), action.id);
      if (approval) this.approvalService.fail(approval.id, error);
      throw error;
    }
  }
}
