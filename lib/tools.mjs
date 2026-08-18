import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { executeMacro, macroSchema } from "./macros.mjs";
import { getDateTime } from "./time.mjs";
import { createToolSignal, defineToolContract, dryRunToolContract, throwIfToolAborted } from "./tool-contracts.mjs";
import { EVOLV_USER_AGENT } from "./version.mjs";
import { PHYSICS_KINDS } from "./physics.mjs";

const MACRO_PREFIX = "macro_";

const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_API_BYTES = 262_144;
const API_HOSTS = new Set([
  "api.frankfurter.dev",
  "api.kanye.rest",
  "api.open-meteo.com",
  "en.wikipedia.org",
  "geocoding-api.open-meteo.com"
]);
const DENIED_SEGMENTS = new Set([".git", "node_modules", "data", "backups", ".agents", ".codex"]);
const DENIED_NAMES = [
  /^\.env(?:\.|$)/i,
  /credential/i,
  /secret/i,
  /private[-_.]?key/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.(?:pem|pfx|p12|key|crt|cer)$/i
];
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv",
  ".sql", ".sh", ".ps1", ".bat", ".cmd", ".py", ".java", ".c", ".cc", ".cpp", ".h",
  ".hpp", ".rs", ".go", ".rb", ".php", ".swift", ".kt", ".gradle", ".properties"
]);

// Linear unit categories: value is how many base units one of the unit equals.
// Temperature is handled separately because it needs offsets, not just scaling.
const UNIT_CATEGORIES = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  mass: { g: 1, kg: 1000, mg: 0.001, t: 1e6, lb: 453.59237, oz: 28.349523125, st: 6350.29318 },
  volume: { l: 1, ml: 0.001, m3: 1000, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 },
  speed: { "m/s": 1, "km/h": 1000 / 3600, mph: 1609.344 / 3600, knot: 1852 / 3600, "ft/s": 0.3048 }
};
const TEMPERATURE_UNITS = new Set(["c", "f", "k"]);
const HASH_ALGORITHMS = new Set(["sha256", "sha1", "sha512", "md5"]);
const TEXT_ENCODINGS = new Set(["base64", "base64url", "hex", "url"]);

function toBaseTemperature(value, unit) {
  if (unit === "c") return value;
  if (unit === "f") return (value - 32) * (5 / 9);
  return value - 273.15; // kelvin
}

function fromBaseTemperature(celsius, unit) {
  if (unit === "c") return celsius;
  if (unit === "f") return celsius * (9 / 5) + 32;
  return celsius + 273.15;
}

function encodeText(text, encoding) {
  if (encoding === "url") return encodeURIComponent(text);
  return Buffer.from(text, "utf8").toString(encoding);
}

function decodeText(text, encoding) {
  if (encoding === "url") return decodeURIComponent(text);
  const decoded = Buffer.from(text, encoding).toString("utf8");
  // Buffer silently drops invalid characters; verify the round-trip to catch bad input.
  if (encoding !== "url" && Buffer.from(decoded, "utf8").toString(encoding).replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw toolError(`Input is not valid ${encoding}.`, "INVALID_ARGUMENT");
  }
  return decoded;
}

function toolError(message, code = "TOOL_ERROR") {
  return Object.assign(new Error(message), { code });
}

function number(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw toolError(`${name} must be a finite number.`, "INVALID_ARGUMENT");
  return result;
}

class ArithmeticParser {
  constructor(source) {
    this.source = String(source).replace(/\s+/g, "");
    this.index = 0;
  }
  parse() {
    if (!this.source || this.source.length > 500) throw toolError("Expression must be 1–500 characters.", "INVALID_ARGUMENT");
    const result = this.expression();
    if (this.index !== this.source.length) throw toolError(`Unexpected token at position ${this.index + 1}.`, "INVALID_EXPRESSION");
    if (!Number.isFinite(result)) throw toolError("Expression produced a non-finite result.", "INVALID_EXPRESSION");
    return result;
  }
  expression() {
    let value = this.term();
    while (this.peek("+") || this.peek("-")) {
      const operator = this.source[this.index++];
      const right = this.term();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  term() {
    let value = this.power();
    while (this.peek("*") || this.peek("/") || this.peek("%")) {
      const operator = this.source[this.index++];
      const right = this.power();
      if ((operator === "/" || operator === "%") && right === 0) throw toolError("Division by zero.", "INVALID_EXPRESSION");
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
    return value;
  }
  power() {
    let value = this.unary();
    if (this.peek("^")) {
      this.index += 1;
      value **= this.power();
    }
    return value;
  }
  unary() {
    if (this.peek("+")) {
      this.index += 1;
      return this.unary();
    }
    if (this.peek("-")) {
      this.index += 1;
      return -this.unary();
    }
    return this.primary();
  }
  primary() {
    if (this.peek("(")) {
      this.index += 1;
      const value = this.expression();
      if (!this.peek(")")) throw toolError("Missing closing parenthesis.", "INVALID_EXPRESSION");
      this.index += 1;
      return value;
    }
    const match = this.source.slice(this.index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (!match) throw toolError(`Expected a number at position ${this.index + 1}.`, "INVALID_EXPRESSION");
    this.index += match[0].length;
    return Number(match[0]);
  }
  peek(token) {
    return this.source.startsWith(token, this.index);
  }
}

function summarizeResult(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function capOutput(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= MAX_OUTPUT_CHARS) return serialized;
  return `${serialized.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`;
}

function validateObject(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw toolError("Arguments must be an object.", "INVALID_ARGUMENT");
  return args;
}

function sanitizeToolArguments(value, key = "", depth = 0) {
  if (depth > 6) return "[depth limit]";
  if (/(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|recovery|secret|token)/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (value.length <= 2_000) return value;
    return `[${value.length} chars; sha256:${crypto.createHash("sha256").update(value).digest("hex")}]`;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeToolArguments(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100)
    .map(([childKey, child]) => [childKey, sanitizeToolArguments(child, childKey, depth + 1)]));
  return value;
}

function serializedToolArguments(value) {
  return JSON.stringify(sanitizeToolArguments(value || {})).slice(0, 24_000);
}

function boundedText(value, maxLength = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function decodeHtmlText(value) {
  return boundedText(String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code)))));
}

async function readBoundedResponse(response, limit = MAX_API_BYTES, signal = null) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw toolError("API response exceeded the size limit.", "OUTPUT_LIMIT");
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw toolError("API response exceeded the size limit.", "OUTPUT_LIMIT");
    return buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    throwIfToolAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw toolError("API response exceeded the size limit.", "OUTPUT_LIMIT");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchApiJson(fetchImpl, input, signal = null) {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "https:" || !API_HOSTS.has(url.hostname) || url.username || url.password) {
    throw toolError("API destination is not permitted.", "NETWORK_DENIED");
  }
  let response;
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: requestSignal,
      headers: { accept: "application/json", "user-agent": EVOLV_USER_AGENT }
    });
  } catch (error) {
    const cancelled = signal?.aborted && signal.reason?.name !== "TimeoutError";
    const timedOut = !cancelled && (error?.name === "AbortError" || error?.name === "TimeoutError");
    throw toolError(cancelled ? "The API request was cancelled." : timedOut ? "The API request timed out." : "The API could not be reached.",
      cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "NETWORK_ERROR");
  }
  if (response.status >= 300 && response.status < 400) throw toolError("API redirects are not permitted.", "NETWORK_DENIED");
  if (!response.ok) throw toolError(`The API returned HTTP ${response.status}.`, "UPSTREAM_ERROR");
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("json")) throw toolError("The API returned an unexpected content type.", "UPSTREAM_ERROR");
  try {
    return JSON.parse(await readBoundedResponse(response, MAX_API_BYTES, signal));
  } catch (error) {
    if (error?.code) throw error;
    throw toolError("The API returned invalid JSON.", "UPSTREAM_ERROR");
  }
}

function weatherDescription(code) {
  const descriptions = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog", 51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
    56: "light freezing drizzle", 57: "dense freezing drizzle", 61: "slight rain", 63: "moderate rain", 65: "heavy rain",
    66: "light freezing rain", 67: "heavy freezing rain", 71: "slight snowfall", 73: "moderate snowfall", 75: "heavy snowfall",
    77: "snow grains", 80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
    85: "slight snow showers", 86: "heavy snow showers", 95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail"
  };
  return descriptions[Number(code)] || "unknown conditions";
}

async function createPathGuard(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const realRoot = await fs.realpath(root);

  function denied(relative) {
    const segments = relative.split(/[\\/]/).filter(Boolean);
    if (segments.some((segment) => {
      const lower = segment.toLowerCase();
      return DENIED_SEGMENTS.has(lower) || lower.startsWith("out-") || lower.startsWith("dist-");
    })) return true;
    return segments.some((segment) => DENIED_NAMES.some((pattern) => pattern.test(segment)));
  }

  async function resolveSafe(input = ".") {
    const raw = String(input || ".");
    if (raw.includes("\0")) throw toolError("Invalid path.", "PATH_DENIED");
    const resolved = path.resolve(root, raw);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw toolError("Path leaves the allowed workspace.", "PATH_DENIED");
    }
    const relative = path.relative(root, resolved);
    if (denied(relative)) throw toolError("That path is protected.", "PATH_DENIED");
    let real;
    try {
      real = await fs.realpath(resolved);
    } catch (error) {
      if (error.code === "ENOENT") throw toolError("Path does not exist.", "NOT_FOUND");
      throw error;
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw toolError("Symlink leaves the allowed workspace.", "PATH_DENIED");
    }
    return { absolute: real, relative: relative || "." };
  }

  return { root, realRoot, resolveSafe, denied };
}

export async function createToolRegistry({ workspaceRoot, database, searchKnowledge, searchMemory, vaultService = null, engineeringActions = null, approvalService = null, projectService = null, sandboxService = null, physicsService = null, fetchImpl = globalThis.fetch }) {
  const guard = await createPathGuard(workspaceRoot);
  const projectGuards = new Map();
  async function guardFor(context = {}) {
    if (projectService) {
      const selectedRoot = await projectService.rootFor(context.projectId);
      const canonicalRoot = path.resolve(selectedRoot);
      if (!projectGuards.has(canonicalRoot)) projectGuards.set(canonicalRoot, createPathGuard(canonicalRoot));
      return projectGuards.get(canonicalRoot);
    }
    const selected = String(context.projectRoot || "").trim();
    if (!selected) return guard;
    const canonical = path.resolve(selected);
    if (!projectGuards.has(canonical)) projectGuards.set(canonical, createPathGuard(canonical));
    return projectGuards.get(canonical);
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  async function collectFiles(startPath, maxDepth = 2, maxResults = 200, context = {}) {
    throwIfToolAborted(context.signal);
    const activeGuard = await guardFor(context);
    const start = await activeGuard.resolveSafe(startPath);
    const output = [];
    async function walk(absolute, relative, depth) {
      throwIfToolAborted(context.signal);
      if (output.length >= maxResults) return;
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfToolAborted(context.signal);
        if (output.length >= maxResults) break;
        const childRelative = path.join(relative === "." ? "" : relative, entry.name);
        if (activeGuard.denied(childRelative) || entry.isSymbolicLink()) continue;
        const item = { path: childRelative.replaceAll("\\", "/"), type: entry.isDirectory() ? "directory" : "file" };
        output.push(item);
        if (entry.isDirectory() && depth < maxDepth) {
          await walk(path.join(absolute, entry.name), childRelative, depth + 1);
        }
      }
    }
    const info = await fs.stat(start.absolute);
    if (!info.isDirectory()) throw toolError("Path must be a directory.", "INVALID_ARGUMENT");
    await walk(start.absolute, start.relative, 0);
    return output;
  }

  const tools = [
    {
      name: "calculate",
      description: "Evaluate an arithmetic expression exactly (numbers, parentheses, +, -, *, /, %, ^). Use for any arithmetic beyond trivial mental math instead of computing it yourself.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["expression"],
        properties: { expression: { type: "string", description: "Arithmetic expression, for example (12+3)*4." } }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.expression !== "string") throw toolError("expression must be a string.", "INVALID_ARGUMENT");
        // Parse during validation so dry runs prove that the restricted grammar accepts the expression.
        new ArithmeticParser(args.expression).parse();
      },
      async execute(args, context = {}) {
        return { expression: args.expression, result: new ArithmeticParser(args.expression).parse() };
      }
    },
    {
      name: "get_datetime",
      description: "Get the current date and time in a requested IANA timezone. Use whenever the answer depends on the current time or a relative date like \"today\" or \"now\".",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        properties: { timezone: { type: "string", description: "IANA timezone such as America/Chicago. Defaults to the server timezone." } }
      },
      validate: validateObject,
      async execute(args, context = {}) {
        try {
          return getDateTime(args.timezone);
        } catch {
          throw toolError("Invalid IANA timezone.", "INVALID_ARGUMENT");
        }
      }
    },
    {
      name: "list_obsidian_notes",
      description: "List bounded metadata for notes in the signed-in user's connected private Obsidian vault.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional title, path, or tag filter." },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      validate(args) {
        validateObject(args);
        if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) throw toolError("query must be at most 200 characters.", "INVALID_ARGUMENT");
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw toolError("limit must be 1-100.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        return vaultService.list({ query: args.query || "", limit: args.limit || 50 })
          .map(({ body, ...item }) => item);
      }
    },
    {
      name: "search_obsidian",
      description: "Search the signed-in user's private Obsidian memory and return relevant note excerpts with paths and headings.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "What to find in private Obsidian memory." },
          limit: { type: "integer", minimum: 1, maximum: 10 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw toolError("query must be 1-500 characters.", "INVALID_ARGUMENT");
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) throw toolError("limit must be 1-10.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        return vaultService.search(args.query, args.limit || 6);
      }
    },
    {
      name: "read_obsidian_note",
      description: "Read a bounded note or heading from the connected private Obsidian vault by its opaque note id.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["note_id"],
        properties: {
          note_id: { type: "string" },
          heading: { type: "string" },
          max_chars: { type: "integer", minimum: 100, maximum: 24000 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.note_id !== "string" || !args.note_id.trim() || args.note_id.length > 100) throw toolError("note_id is required.", "INVALID_ARGUMENT");
        if (args.heading !== undefined && (typeof args.heading !== "string" || args.heading.length > 200)) throw toolError("heading is too long.", "INVALID_ARGUMENT");
        if (args.max_chars !== undefined && (!Number.isInteger(args.max_chars) || args.max_chars < 100 || args.max_chars > 24_000)) throw toolError("max_chars must be 100-24000.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        return vaultService.read(args.note_id, { heading: args.heading || "", maxChars: args.max_chars || 12_000 });
      }
    },
    {
      name: "get_obsidian_backlinks",
      description: "List notes that link to a private Obsidian note.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["note_id"],
        properties: { note_id: { type: "string" } }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.note_id !== "string" || !args.note_id.trim() || args.note_id.length > 100) throw toolError("note_id is required.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        return vaultService.backlinks(args.note_id);
      }
    },
    {
      name: "propose_obsidian_create",
      description: "Propose creating a Markdown note in the private Obsidian vault. This only creates a reviewable diff and never writes until the user approves it.",
      risk: "approval-write",
      permission: "evolv.projects.write",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["path", "content", "summary"],
        properties: {
          path: { type: "string", description: "Vault-relative .md path, normally under Memory/." },
          content: { type: "string", description: "Proposed Markdown body." },
          summary: { type: "string", description: "Why this note should be created." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.path !== "string" || !args.path.toLowerCase().endsWith(".md") || args.path.length > 300) throw toolError("path must be a bounded .md path.", "INVALID_ARGUMENT");
        if (typeof args.content !== "string" || args.content.length > 100_000) throw toolError("content must be at most 100 KB.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        const change = vaultService.proposeChange({ kind: "create", path: args.path, content: args.content, summary: args.summary, ...context });
        return { approvalRequired: true, changeId: change.id, change };
      }
    },
    ...["edit", "move", "archive"].map((kind) => ({
      name: `propose_obsidian_${kind}`,
      description: `Propose ${kind === "edit" ? "editing" : kind === "move" ? "moving" : "archiving"} a private Obsidian note. This creates a reviewable change and never modifies the vault until the user approves it.`,
      risk: "approval-write",
      permission: "evolv.projects.write",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["note_id", "summary", ...(kind === "edit" ? ["content"] : []), ...(kind === "move" ? ["destination_path"] : [])],
        properties: {
          note_id: { type: "string" },
          content: { type: "string", description: "Complete proposed Markdown body." },
          destination_path: { type: "string", description: "New vault-relative .md path." },
          summary: { type: "string" }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.note_id !== "string" || !args.note_id.trim() || args.note_id.length > 100) throw toolError("note_id is required.", "INVALID_ARGUMENT");
        if (kind === "edit" && (typeof args.content !== "string" || args.content.length > 100_000)) throw toolError("content must be at most 100 KB.", "INVALID_ARGUMENT");
        if (kind === "move" && (typeof args.destination_path !== "string" || !args.destination_path.toLowerCase().endsWith(".md") || args.destination_path.length > 300)) throw toolError("destination_path must be a bounded .md path.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!vaultService?.connected()) throw toolError("No Obsidian vault is connected.", "VAULT_DISCONNECTED");
        const change = vaultService.proposeChange({
          kind,
          noteId: args.note_id,
          content: args.content || "",
          destinationPath: args.destination_path || "",
          summary: args.summary || "",
          ...context
        });
        return { approvalRequired: true, changeId: change.id, change };
      }
    })),
    {
      name: "propose_workspace_edit",
      description: "Propose a bounded exact-text edit to a permitted project file. The file is not changed until the user reviews and approves the diff card.",
      risk: "approval-write",
      permission: "filesystem.write.project",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["path", "find", "replace", "summary"],
        properties: {
          path: { type: "string", description: "Project-relative text-file path." },
          find: { type: "string", description: "Exact existing text to replace." },
          replace: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every exact match. False requires one unique match." },
          summary: { type: "string", description: "Why this edit is needed." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.path !== "string" || !args.path.trim() || args.path.length > 300) throw toolError("path must be 1-300 characters.", "INVALID_ARGUMENT");
        if (typeof args.find !== "string" || !args.find || args.find.length > 100_000) throw toolError("find must be 1-100000 characters.", "INVALID_ARGUMENT");
        if (typeof args.replace !== "string" || args.replace.length > 100_000) throw toolError("replace must be at most 100000 characters.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!engineeringActions) throw toolError("Engineering actions are unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return engineeringActions.proposeEdit(context.runId, { ...args, create: false, projectId: context.projectId, projectRoot: context.projectRoot });
      }
    },
    {
      name: "open_sandbox",
      description: "Open a private sandbox holding a copy of the project's text files. Use this before attempting a change so the work can be tried, checked, and thrown away without touching the real project.",
      risk: "sandbox",
      permission: "filesystem.read.project",
      timeoutMs: 30_000,
      schema: {
        type: "object",
        properties: { objective: { type: "string", description: "What this simulation is meant to achieve." } }
      },
      validate(args) {
        validateObject(args);
        if (args.objective !== undefined && (typeof args.objective !== "string" || args.objective.length > 2000)) {
          throw toolError("objective must be at most 2000 characters.", "INVALID_ARGUMENT");
        }
      },
      async execute(args, context = {}) {
        if (!sandboxService) throw toolError("The sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        const session = await sandboxService.open({
          projectId: context.projectId, objective: args.objective || "",
          agentRunId: context.agentRunId || null, conversationId: context.conversationId || null
        });
        return {
          sessionId: session.id, files: session.fileCount, truncated: session.truncated,
          note: "Nothing in the real project changes until a promotion is approved."
        };
      }
    },
    {
      name: "sandbox_write_file",
      description: "Write a complete file inside an open sandbox. The real project is not modified. Use this to try a change before proposing it.",
      risk: "sandbox",
      permission: "filesystem.read.project",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["session_id", "path", "content"],
        properties: {
          session_id: { type: "string", description: "Sandbox session identifier from open_sandbox." },
          path: { type: "string", description: "Project-relative text-file path." },
          content: { type: "string", description: "Complete file content, at most 2 MB." },
          summary: { type: "string", description: "Why this change is being tried." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.session_id !== "string" || !args.session_id.trim()) throw toolError("session_id is required.", "INVALID_ARGUMENT");
        if (typeof args.path !== "string" || !args.path.trim() || args.path.length > 300) throw toolError("path must be 1-300 characters.", "INVALID_ARGUMENT");
        if (typeof args.content !== "string" || Buffer.byteLength(args.content) > 2 * 1024 * 1024) throw toolError("content must be at most 2 MB.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!sandboxService) throw toolError("The sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        const session = await sandboxService.applyEdit(args.session_id, {
          path: args.path, content: args.content, summary: args.summary || ""
        });
        return { sessionId: session.id, staged: session.edits.map((edit) => edit.relativePath), state: session.state };
      }
    },
    {
      name: "sandbox_validate",
      description: "Syntax-check the simulated files and optionally run approved package scripts (test, lint, check, typecheck, build, format:check) inside the sandbox. Runs against the copy, never the real project.",
      risk: "sandbox",
      permission: "filesystem.read.project",
      timeoutMs: 180_000,
      schema: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: { type: "string" },
          scripts: { type: "array", items: { type: "string" }, description: "Package scripts to run, at most four." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.session_id !== "string" || !args.session_id.trim()) throw toolError("session_id is required.", "INVALID_ARGUMENT");
        if (args.scripts !== undefined && (!Array.isArray(args.scripts) || args.scripts.length > 4)) throw toolError("scripts must be an array of at most four names.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        if (!sandboxService) throw toolError("The sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        const session = await sandboxService.validate(args.session_id, { scripts: args.scripts || [] });
        return {
          sessionId: session.id, state: session.state, passed: session.state === "validated",
          checks: session.validations.map((item) => ({ kind: item.kind, passed: item.passed, summary: item.summary }))
        };
      }
    },
    {
      name: "propose_sandbox_promotion",
      description: "Propose applying a validated sandbox's changes to the real project. Nothing is written until the user reviews and approves the complete set.",
      risk: "approval-write",
      permission: "filesystem.write.project",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["session_id", "summary"],
        properties: {
          session_id: { type: "string" },
          summary: { type: "string", description: "What these changes accomplish." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.session_id !== "string" || !args.session_id.trim()) throw toolError("session_id is required.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!sandboxService) throw toolError("The sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        if (!engineeringActions) throw toolError("Engineering actions are unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        const session = sandboxService.get(args.session_id);
        if (!session.edits.length) throw toolError("This sandbox changed nothing to promote.", "SANDBOX_EMPTY");
        if (session.state !== "validated") throw toolError("Validate the sandbox before proposing promotion.", "SANDBOX_NOT_VALIDATED");
        // Routed through the engineering-action envelope so promotion reuses
        // the existing approval, audit, and agent-run settling path.
        return engineeringActions.save(context.runId, "sandbox-promotion", {
          sessionId: session.id,
          preview: {
            summary: String(args.summary).slice(0, 500),
            operation: "sandbox-promotion",
            files: session.edits.map((edit) => ({ path: edit.relativePath, operation: edit.operation, bytes: edit.bytes })),
            checks: session.validations.map((item) => ({ kind: item.kind, passed: item.passed })),
            afterLines: session.edits.length
          }
        });
      }
    },
    {
      name: "propose_workspace_create",
      description: "Propose creating a bounded project text file. Nothing is written until the user reviews and approves the complete preview.",
      risk: "approval-write",
      permission: "filesystem.write.project",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["path", "content", "summary"],
        properties: {
          path: { type: "string", description: "Project-relative new text-file path in an existing directory." },
          content: { type: "string", description: "Complete proposed file content, at most 512 KB." },
          summary: { type: "string", description: "Why this file is needed." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.path !== "string" || !args.path.trim() || args.path.length > 300) throw toolError("path must be 1-300 characters.", "INVALID_ARGUMENT");
        if (typeof args.content !== "string" || Buffer.byteLength(args.content) > 512 * 1024) throw toolError("content must be at most 512 KB.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!engineeringActions) throw toolError("Engineering actions are unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return engineeringActions.proposeEdit(context.runId, { ...args, create: true, projectId: context.projectId, projectRoot: context.projectRoot });
      }
    },
    {
      name: "propose_engineering_check",
      description: "Propose a safe engineering verification command. Only git status/diff, a bounded Node test file, or an approved test/lint/check/typecheck/build package script may run, and only after user approval.",
      risk: "approval-write",
      permission: "terminal.execute.approved",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["check", "summary"],
        properties: {
          check: { type: "string", enum: ["git-status", "git-diff", "node-test", "npm-script"] },
          path: { type: "string", description: "Project-relative test file for node-test." },
          script: { type: "string", description: "Package script name for npm-script." },
          timeout_ms: { type: "integer", minimum: 5000, maximum: 300000 },
          summary: { type: "string", description: "What this check will verify." }
        }
      },
      validate(args) {
        validateObject(args);
        if (!["git-status", "git-diff", "node-test", "npm-script"].includes(args.check)) throw toolError("check is not permitted.", "INVALID_ARGUMENT");
        if (args.path !== undefined && (typeof args.path !== "string" || args.path.length > 300)) throw toolError("path is invalid.", "INVALID_ARGUMENT");
        if (args.script !== undefined && (typeof args.script !== "string" || args.script.length > 100)) throw toolError("script is invalid.", "INVALID_ARGUMENT");
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) throw toolError("summary must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!engineeringActions) throw toolError("Engineering actions are unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return engineeringActions.proposeCheck(context.runId, { ...args, projectId: context.projectId, projectRoot: context.projectRoot });
      }
    },
    {
      name: "propose_web_research",
      description: "Propose retrieving one public HTTPS text or JSON page for bounded research. The request pauses for approval, blocks private-network destinations and redirects, and treats all returned text as untrusted evidence.",
      risk: "approval-write",
      permission: "network.internet",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        required: ["url", "purpose"],
        properties: {
          url: { type: "string", description: "Public HTTPS URL with no embedded credentials." },
          purpose: { type: "string", description: "Why this exact source is relevant." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.url !== "string" || args.url.length > 2000) throw toolError("url must be at most 2000 characters.", "INVALID_ARGUMENT");
        if (typeof args.purpose !== "string" || !args.purpose.trim() || args.purpose.length > 500) throw toolError("purpose must be 1-500 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!engineeringActions) throw toolError("Engineering actions are unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return engineeringActions.proposeResearch(context.runId, args);
      }
    },
    {
      name: "get_weather",
      description: "Get current weather and a short forecast for a named place from Open-Meteo. Use for live weather questions instead of guessing.",
      risk: "network-read",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["location"],
        properties: {
          location: { type: "string", description: "City or place name, optionally including state or country." },
          forecast_days: { type: "integer", minimum: 1, maximum: 7 },
          units: { type: "string", enum: ["fahrenheit", "celsius"] }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.location !== "string" || args.location.trim().length < 2 || args.location.trim().length > 120) {
          throw toolError("location must be 2-120 characters.", "INVALID_ARGUMENT");
        }
        if (args.forecast_days !== undefined && (!Number.isInteger(args.forecast_days) || args.forecast_days < 1 || args.forecast_days > 7)) {
          throw toolError("forecast_days must be an integer from 1 to 7.", "INVALID_ARGUMENT");
        }
        if (args.units !== undefined && !["fahrenheit", "celsius"].includes(args.units)) {
          throw toolError("units must be fahrenheit or celsius.", "INVALID_ARGUMENT");
        }
      },
      async execute(args, context = {}) {
        const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
        geocodeUrl.search = new URLSearchParams({ name: args.location.trim(), count: "1", language: "en", format: "json" });
        const geocoding = await fetchApiJson(fetchImpl, geocodeUrl, context.signal);
        const place = Array.isArray(geocoding?.results) ? geocoding.results[0] : null;
        if (!place || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) {
          throw toolError("No matching weather location was found.", "NOT_FOUND");
        }
        const units = args.units || "fahrenheit";
        const days = args.forecast_days || 3;
        const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
        forecastUrl.search = new URLSearchParams({
          latitude: String(place.latitude), longitude: String(place.longitude), timezone: "auto", forecast_days: String(days),
          temperature_unit: units, wind_speed_unit: units === "fahrenheit" ? "mph" : "kmh",
          current: "temperature_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
        });
        const data = await fetchApiJson(fetchImpl, forecastUrl, context.signal);
        const daily = data?.daily || {};
        const times = Array.isArray(daily.time) ? daily.time : [];
        return {
          provider: "Open-Meteo",
          attribution: "Weather data by Open-Meteo (CC BY 4.0)",
          location: {
            name: boundedText(place.name, 120), admin1: boundedText(place.admin1, 120), country: boundedText(place.country, 120),
            latitude: Number(place.latitude), longitude: Number(place.longitude), timezone: boundedText(data?.timezone || place.timezone, 80)
          },
          units: {
            temperature: units === "fahrenheit" ? "°F" : "°C",
            windSpeed: units === "fahrenheit" ? "mph" : "km/h"
          },
          current: {
            time: boundedText(data?.current?.time, 40), conditions: weatherDescription(data?.current?.weather_code),
            temperature: Number(data?.current?.temperature_2m), feelsLike: Number(data?.current?.apparent_temperature),
            precipitation: Number(data?.current?.precipitation), rain: Number(data?.current?.rain), cloudCoverPercent: Number(data?.current?.cloud_cover),
            windSpeed: Number(data?.current?.wind_speed_10m), windDirectionDegrees: Number(data?.current?.wind_direction_10m), isDay: Boolean(data?.current?.is_day)
          },
          forecast: times.slice(0, days).map((date, index) => ({
            date: boundedText(date, 20), conditions: weatherDescription(daily.weather_code?.[index]), high: Number(daily.temperature_2m_max?.[index]),
            low: Number(daily.temperature_2m_min?.[index]), precipitationChancePercent: Number(daily.precipitation_probability_max?.[index]),
            sunrise: boundedText(daily.sunrise?.[index], 40), sunset: boundedText(daily.sunset?.[index], 40)
          }))
        };
      }
    },
    {
      name: "get_kanye_quote",
      description: "Get a random short Kanye West quote from kanye.rest. Use when the user asks for a Kanye quote or a random quote from Kanye.",
      risk: "network-read",
      timeoutMs: 10_000,
      schema: { type: "object", properties: {} },
      validate: validateObject,
      async execute(_args, context = {}) {
        const data = await fetchApiJson(fetchImpl, "https://api.kanye.rest/", context.signal);
        const quote = boundedText(data?.quote, 500);
        if (!quote) throw toolError("The quote service returned no quote.", "UPSTREAM_ERROR");
        return { quote, attributedTo: "Kanye West", provider: "kanye.rest" };
      }
    },
    {
      name: "convert_currency",
      description: "Convert an amount between ISO currencies using the latest reference rate from Frankfurter. Use for current exchange-rate questions; this is not a live trading quote.",
      risk: "network-read",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        required: ["amount", "from", "to"],
        properties: {
          amount: { type: "number", minimum: 0, maximum: 1000000000000 },
          from: { type: "string", description: "Three-letter source currency code, such as USD." },
          to: { type: "string", description: "Three-letter target currency code, such as EUR." }
        }
      },
      validate(args) {
        validateObject(args);
        const amount = number(args.amount, "amount");
        if (amount < 0 || amount > 1e12) throw toolError("amount must be from 0 to 1 trillion.", "INVALID_ARGUMENT");
        if (!/^[A-Za-z]{3}$/.test(String(args.from)) || !/^[A-Za-z]{3}$/.test(String(args.to))) {
          throw toolError("from and to must be three-letter currency codes.", "INVALID_ARGUMENT");
        }
      },
      async execute(args, context = {}) {
        const amount = number(args.amount, "amount");
        const from = String(args.from).toUpperCase();
        const to = String(args.to).toUpperCase();
        if (from === to) return { amount, from, to, rate: 1, convertedAmount: amount, date: null, provider: "Frankfurter", note: "Same-currency conversion." };
        const data = await fetchApiJson(fetchImpl, `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, context.signal);
        const rate = Number(data?.rate);
        if (!Number.isFinite(rate) || rate <= 0) throw toolError("The exchange-rate service returned an invalid rate.", "UPSTREAM_ERROR");
        return {
          amount, from, to, rate, convertedAmount: Number((amount * rate).toFixed(6)), date: boundedText(data?.date, 20),
          provider: "Frankfurter", note: "Reference rate only; banks and payment services may use different rates and fees."
        };
      }
    },
    {
      name: "search_wikipedia",
      description: "Search English Wikipedia and return a few article matches with plain-text snippets and links. Use for general factual topic discovery, then verify important claims with stronger sources when needed.",
      risk: "network-read",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Topic or search phrase." },
          limit: { type: "integer", minimum: 1, maximum: 5 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || args.query.trim().length < 1 || args.query.trim().length > 200) {
          throw toolError("query must be 1-200 characters.", "INVALID_ARGUMENT");
        }
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) {
          throw toolError("limit must be an integer from 1 to 5.", "INVALID_ARGUMENT");
        }
      },
      async execute(args, context = {}) {
        const limit = args.limit || 3;
        const url = new URL("https://en.wikipedia.org/w/api.php");
        url.search = new URLSearchParams({ action: "query", list: "search", srsearch: args.query.trim(), srlimit: String(limit), utf8: "1", format: "json" });
        const data = await fetchApiJson(fetchImpl, url, context.signal);
        const results = Array.isArray(data?.query?.search) ? data.query.search : [];
        return {
          provider: "Wikipedia",
          query: args.query.trim(),
          results: results.slice(0, limit).map((item) => {
            const title = boundedText(item.title, 200);
            return {
              title, snippet: decodeHtmlText(item.snippet), pageId: Number(item.pageid), wordCount: Number(item.wordcount),
              lastEdited: boundedText(item.timestamp, 40), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`
            };
          })
        };
      }
    },
    {
      name: "search_knowledge",
      description: "Semantically search user-approved Evolv knowledge records.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          domain: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 10 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || !args.query.trim()) throw toolError("query is required.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
        const results = await searchKnowledge(args.query);
        return results.filter((item) => !args.domain || item.domain === args.domain).slice(0, limit)
          .map(({ embedding, ...item }) => item);
      }
    },
    {
      name: "search_memory",
      description: "Search the user's approved project memory graph: their ongoing projects, tasks, decisions, and preferences remembered from earlier sessions.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          type: { type: "string", enum: ["project", "task", "decision", "preference", "note"] },
          limit: { type: "integer", minimum: 1, maximum: 10 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || !args.query.trim()) throw toolError("query is required.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!searchMemory) return [];
        const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
        const results = await searchMemory(args.query, context);
        return results.filter((item) => !args.type || item.type === args.type).slice(0, limit)
          .map(({ embedding, ...item }) => item);
      }
    },
    {
      name: "search_project_knowledge",
      description: "Search indexed, user-approved sources in the active project and return exact source locators for citation.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 10 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 1000) throw toolError("query is required and must be at most 1000 characters.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!projectService) throw toolError("Project knowledge is unavailable.", "CAPABILITY_UNAVAILABLE");
        return projectService.search(context.projectId, args.query, args.limit || 5);
      }
    },
    {
      name: "list_project_tasks",
      description: "List the active project's durable tasks and their current status.",
      risk: "read",
      permission: "evolv.projects.read",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        properties: { status: { type: "string", enum: ["open", "in-progress", "blocked", "done", "archived"] } }
      },
      validate(args) {
        validateObject(args);
        if (args.status !== undefined && !["open", "in-progress", "blocked", "done", "archived"].includes(args.status)) throw toolError("status is invalid.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        if (!projectService) throw toolError("Project tasks are unavailable.", "CAPABILITY_UNAVAILABLE");
        if (!context.projectId) throw toolError("Choose an active project.", "PROJECT_REQUIRED");
        return projectService.listTasks(context.projectId, args.status || "").slice(0, 100);
      }
    },
    {
      name: "list_workspace_files",
      description: "List files and directories inside the active project's explicitly granted folder. Protected and private paths are excluded.",
      risk: "read",
      permission: "filesystem.read.project",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory. Defaults to the workspace root." },
          depth: { type: "integer", minimum: 0, maximum: 3 },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        }
      },
      validate: validateObject,
      async execute(args, context = {}) {
        return collectFiles(args.path || ".", Math.max(0, Math.min(3, Number(args.depth) || 1)), Math.max(1, Math.min(200, Number(args.limit) || 100)), context);
      }
    },
    {
      name: "read_workspace_text",
      description: "Read a bounded range from a permitted text file inside the Evolv workspace.",
      risk: "read",
      permission: "filesystem.read.project",
      timeoutMs: 10_000,
      schema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          max_lines: { type: "integer", minimum: 1, maximum: 500 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.path !== "string" || !args.path) throw toolError("path is required.", "INVALID_ARGUMENT");
      },
      async execute(args, context = {}) {
        throwIfToolAborted(context.signal);
        const activeGuard = await guardFor(context);
        const target = await activeGuard.resolveSafe(args.path);
        const info = await fs.stat(target.absolute);
        if (!info.isFile()) throw toolError("Path must be a file.", "INVALID_ARGUMENT");
        if (info.size > MAX_FILE_BYTES) throw toolError("File exceeds the 1 MB read limit.", "OUTPUT_LIMIT");
        if (!TEXT_EXTENSIONS.has(path.extname(target.absolute).toLowerCase())) throw toolError("File type is not permitted.", "PATH_DENIED");
        const text = await fs.readFile(target.absolute, { encoding: "utf8", signal: context.signal });
        if (text.includes("\0")) throw toolError("Binary content is not permitted.", "PATH_DENIED");
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, Number(args.start_line) || 1);
        const maxLines = Math.max(1, Math.min(500, Number(args.max_lines) || 200));
        return {
          path: target.relative.replaceAll("\\", "/"),
          startLine: start,
          endLine: Math.min(lines.length, start + maxLines - 1),
          totalLines: lines.length,
          content: lines.slice(start - 1, start - 1 + maxLines).map((line, index) => `${start + index}: ${line}`).join("\n")
        };
      }
    },
    {
      name: "search_workspace_text",
      description: "Search permitted workspace text files for a literal text query.",
      risk: "read",
      permission: "filesystem.read.project",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          extension: { type: "string", description: "Optional extension such as .js or .md." },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.query !== "string" || args.query.length < 1 || args.query.length > 300) {
          throw toolError("query must be 1–300 characters.", "INVALID_ARGUMENT");
        }
      },
      async execute(args, context = {}) {
        throwIfToolAborted(context.signal);
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
        const activeGuard = await guardFor(context);
        const files = (await collectFiles(args.path || ".", 3, 500, context)).filter((item) => item.type === "file");
        const query = args.query.toLowerCase();
        const extension = args.extension ? (String(args.extension).startsWith(".") ? String(args.extension) : `.${args.extension}`) : "";
        const matches = [];
        for (const file of files) {
          throwIfToolAborted(context.signal);
          if (matches.length >= limit) break;
          if (extension && path.extname(file.path).toLowerCase() !== extension.toLowerCase()) continue;
          if (!TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase())) continue;
          const target = await activeGuard.resolveSafe(file.path);
          const info = await fs.stat(target.absolute);
          if (info.size > MAX_FILE_BYTES) continue;
          const lines = (await fs.readFile(target.absolute, { encoding: "utf8", signal: context.signal })).split(/\r?\n/);
          for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
            if (lines[index].toLowerCase().includes(query)) {
              matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 500) });
            }
          }
        }
        return matches;
      }
    },
    {
      name: "inspect_json",
      description: "Parse JSON text and optionally retrieve a value using a dot-separated property path.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["json"],
        properties: {
          json: { type: "string", description: "JSON text, limited to 100 KB." },
          path: { type: "string", description: "Optional safe dot path such as users.0.name." }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.json !== "string" || args.json.length > 100_000) throw toolError("json must be text no larger than 100 KB.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        let value;
        try {
          value = JSON.parse(args.json);
        } catch (error) {
          throw toolError(`Invalid JSON: ${error.message}`, "INVALID_JSON");
        }
        const queryPath = String(args.path || "").trim();
        if (queryPath) {
          for (const segment of queryPath.split(".")) {
            if (!/^(?:[A-Za-z_$][\w$]*|\d+)$/.test(segment) || ["__proto__", "prototype", "constructor"].includes(segment)) {
              throw toolError("Unsafe JSON property path.", "INVALID_ARGUMENT");
            }
            value = value?.[segment];
          }
        }
        return { path: queryPath || "$", type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value, value };
      }
    },
    {
      name: "convert_units",
      description: "Convert a value between units of the same kind (length, mass, volume, time, data, speed, or temperature). Use for any unit conversion instead of estimating.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["value", "from", "to"],
        properties: {
          value: { type: "number" },
          from: { type: "string", description: "Source unit, e.g. km, lb, floz, c, mph." },
          to: { type: "string", description: "Target unit of the same kind." }
        }
      },
      validate(args) {
        validateObject(args);
        number(args.value, "value");
        if (typeof args.from !== "string" || typeof args.to !== "string") throw toolError("from and to must be unit strings.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        const value = number(args.value, "value");
        const from = String(args.from).trim().toLowerCase();
        const to = String(args.to).trim().toLowerCase();
        if (TEMPERATURE_UNITS.has(from) || TEMPERATURE_UNITS.has(to)) {
          if (!TEMPERATURE_UNITS.has(from) || !TEMPERATURE_UNITS.has(to)) throw toolError("Cannot convert between temperature and non-temperature units.", "INVALID_ARGUMENT");
          return { value, from, to, category: "temperature", result: fromBaseTemperature(toBaseTemperature(value, from), to) };
        }
        const category = Object.keys(UNIT_CATEGORIES).find((name) => from in UNIT_CATEGORIES[name] && to in UNIT_CATEGORIES[name]);
        if (!category) throw toolError("Unknown units, or the units are of different kinds.", "INVALID_ARGUMENT");
        const table = UNIT_CATEGORIES[category];
        return { value, from, to, category, result: (value * table[from]) / table[to] };
      }
    },
    {
      name: "text_stats",
      description: "Count characters, words, lines, and sentences in text and estimate reading time. Use for word-count or text-length questions.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", description: "Text to analyze, up to 200 KB." } }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.text !== "string" || args.text.length > 200_000) throw toolError("text must be a string no larger than 200 KB.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        const text = args.text;
        const words = (text.trim().match(/\S+/g) || []).length;
        return {
          characters: text.length,
          charactersNoSpaces: text.replace(/\s/g, "").length,
          words,
          lines: text.length ? text.split(/\r?\n/).length : 0,
          sentences: (text.match(/[.!?]+(?:\s|$)/g) || []).length,
          readingTimeMinutes: Number((words / 200).toFixed(2))
        };
      }
    },
    {
      name: "hash_text",
      description: "Compute a cryptographic hash (sha256, sha1, sha512, or md5) of the provided text. Use when the user asks for a hash, digest, or checksum.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Text to hash, up to 100 KB." },
          algorithm: { type: "string", enum: ["sha256", "sha1", "sha512", "md5"] }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.text !== "string" || args.text.length > 100_000) throw toolError("text must be a string no larger than 100 KB.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        const algorithm = String(args.algorithm || "sha256").toLowerCase();
        if (!HASH_ALGORITHMS.has(algorithm)) throw toolError("Unsupported hash algorithm.", "INVALID_ARGUMENT");
        return { algorithm, hex: crypto.createHash(algorithm).update(args.text, "utf8").digest("hex") };
      }
    },
    {
      name: "encode_text",
      description: "Encode text to base64, base64url, hex, or URL encoding. Use when the user asks to encode a value.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["text", "encoding"],
        properties: {
          text: { type: "string" },
          encoding: { type: "string", enum: ["base64", "base64url", "hex", "url"] }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.text !== "string" || args.text.length > 100_000) throw toolError("text must be a string no larger than 100 KB.", "INVALID_ARGUMENT");
        if (!TEXT_ENCODINGS.has(String(args.encoding))) throw toolError("encoding must be base64, base64url, hex, or url.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        return { encoding: args.encoding, result: encodeText(args.text, args.encoding) };
      }
    },
    {
      name: "decode_text",
      description: "Decode base64, base64url, hex, or URL-encoded text back to plain text. Use when the user gives an encoded value to decode.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        required: ["text", "encoding"],
        properties: {
          text: { type: "string" },
          encoding: { type: "string", enum: ["base64", "base64url", "hex", "url"] }
        }
      },
      validate(args) {
        validateObject(args);
        if (typeof args.text !== "string" || args.text.length > 200_000) throw toolError("text must be a string no larger than 200 KB.", "INVALID_ARGUMENT");
        if (!TEXT_ENCODINGS.has(String(args.encoding))) throw toolError("encoding must be base64, base64url, hex, or url.", "INVALID_ARGUMENT");
      },
      async execute(args) {
        const result = decodeText(args.text, args.encoding);
        if (result.includes("\0")) throw toolError("Decoded content is not valid text.", "INVALID_ARGUMENT");
        return { encoding: args.encoding, result };
      }
    },
    // The physics sandbox. Every one of these is in the automatic tier: the
    // world is memory, it touches no file, no network, and no project, and
    // clearing it costs nothing. Asking permission to drop a box would be
    // noise, and noise is what teaches people to approve without reading.
    {
      name: "physics_look",
      description: "Look at the physics sandbox: every object's position, speed, mass, what is touching what, and whether the scene has settled. Use before and after changing anything, and to answer questions about what happened.",
      risk: "read",
      timeoutMs: 5_000,
      schema: { type: "object", properties: {} },
      validate: validateObject,
      async execute() {
        if (!physicsService) throw toolError("The physics sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return physicsService.perceive();
      }
    },
    {
      name: "physics_build",
      description: "Add an object to the physics sandbox. Simple shapes: box, circle, triangle, polygon, star. Machines: motor (a pinned spinning wheel), gear (a pinned toothed wheel), car (chassis on two sprung axles). Flexible: chain (stiff links), rope (floppy links) — both hang from where you place them. Also ragdoll (a humanoid figure) and ramp (a fixed angled surface). The world is 800 wide by 600 tall with y increasing downward, so y=0 is the top and objects fall toward y=600.",
      risk: "sandbox",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["kind", "x", "y"],
        properties: {
          kind: { type: "string", enum: PHYSICS_KINDS },
          x: { type: "number", description: "Horizontal position, 0 (left) to 800 (right)." },
          y: { type: "number", description: "Vertical position, 0 (top) to 600 (floor)." },
          material: {
            type: "string", enum: ["default", "rubber", "metal", "wood", "ice"],
            description: "rubber is very bouncy, metal is heavy, wood is light, ice has no friction. Default is a middling plastic."
          },
          width: { type: "number", description: "Box, ramp, or car width. Default 50; ramps 300; cars 110." },
          height: { type: "number", description: "Box, ramp, or car height. Default 50; ramps 20; cars 26." },
          radius: { type: "number", description: "Circle, polygon, star, motor, or gear radius. Default 30; motors 40; gears 45." },
          sides: { type: "integer", description: "Polygon sides, 3 to 12. Default 6." },
          points: { type: "integer", description: "Star points, 3 to 12. Default 5." },
          teeth: { type: "integer", description: "Gear teeth, 3 to 16. Default 8." },
          links: { type: "integer", description: "Chain or rope links, 2 to 30. Default 10 for chain, 14 for rope." },
          wheelSize: { type: "number", description: "Car wheel radius. Default 22." },
          scale: { type: "number", description: "Ragdoll size, 0.4 to 2.5. Default 1." },
          angle: { type: "number", description: "Tilt in radians. Ramps default to 0.3 (about 17 degrees)." },
          speed: { type: "number", description: "Motor or gear spin rate, -1 to 1. Negative reverses." },
          fixed: { type: "boolean", description: "Pin the object in place so gravity cannot move it." },
          bounciness: { type: "number", description: "0 (dead) to 1 (very bouncy). Overrides the material." },
          friction: { type: "number", description: "0 (slippery) to 1 (grippy). Overrides the material." },
          density: { type: "number", description: "Heaviness per unit area. Overrides the material." },
          note: { type: "string", description: "What this object represents." }
        }
      },
      validate(args) {
        validateObject(args);
        if (!PHYSICS_KINDS.includes(args.kind)) {
          throw toolError(`kind must be one of: ${PHYSICS_KINDS.join(", ")}.`, "INVALID_ARGUMENT");
        }
        if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > 200)) {
          throw toolError("note must be at most 200 characters.", "INVALID_ARGUMENT");
        }
      },
      async execute(args) {
        if (!physicsService) throw toolError("The physics sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        // The tool speaks the user's words; the service speaks the solver's.
        // Everything routes through apply() so a model and the toolbar cannot
        // reach different code for the same object.
        const { kind, fixed, bounciness, ...rest } = args;
        return physicsService.apply(`create_${kind}`, {
          ...rest, isStatic: fixed, restitution: bounciness
        });
      }
    },
    {
      name: "physics_connect",
      description: "Join two objects in the physics sandbox. A spring is soft and stretches back; a pin joint holds them at a fixed distance. Use the ids from physics_look, such as box-1.",
      risk: "sandbox",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["joint", "a", "b"],
        properties: {
          joint: { type: "string", enum: ["spring", "pin"] },
          a: { type: "string", description: "First object id." },
          b: { type: "string", description: "Second object id." },
          length: { type: "number", description: "Spring rest length. Defaults to how far apart they already are." },
          stiffness: { type: "number", description: "Spring stiffness, 0.005 (very slack) to 1 (rigid). Default 0.05." }
        }
      },
      validate(args) {
        validateObject(args);
        if (!["spring", "pin"].includes(args.joint)) throw toolError("joint must be spring or pin.", "INVALID_ARGUMENT");
        for (const end of ["a", "b"]) {
          if (typeof args[end] !== "string" || !args[end].trim()) throw toolError(`${end} must be an object id.`, "INVALID_ARGUMENT");
        }
      },
      async execute(args) {
        if (!physicsService) throw toolError("The physics sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return physicsService.apply(args.joint === "pin" ? "connect_pin" : "connect_spring", args);
      }
    },
    {
      name: "physics_run",
      description: "Let time pass in the physics sandbox and report what the scene looks like afterwards. 60 steps is one second. Nothing moves until this is called, so build the scene first, then run it.",
      risk: "sandbox",
      timeoutMs: 15_000,
      schema: {
        type: "object",
        properties: { steps: { type: "integer", minimum: 1, maximum: 600, description: "Simulation steps. 60 = one second. Default 60." } }
      },
      validate: validateObject,
      async execute(args) {
        if (!physicsService) throw toolError("The physics sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        const result = physicsService.step(args.steps === undefined ? 60 : args.steps);
        // Running time and then having to ask what happened would make every
        // experiment two calls; the outcome is the point of the verb.
        return { ...result, scene: physicsService.perceive() };
      }
    },
    {
      name: "physics_adjust",
      description: "Change the physics sandbox without adding anything: set gravity or wind, shove an object, remove one, or clear the scene.",
      risk: "sandbox",
      timeoutMs: 5_000,
      schema: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["set_gravity", "set_wind", "move", "push", "remove", "clear"] },
          x: { type: "number", description: "For move: where to put the object horizontally, 0 to 800." },
          y: { type: "number", description: "For move: where to put the object vertically, 0 (top) to 600 (floor)." },
          gravity: { type: "number", description: "For set_gravity: -5 to 5. Earth is 1, the Moon about 0.17, 0 is weightless, negative falls upward." },
          wind: { type: "number", description: "For set_wind: -3 to 3. A steady sideways push, positive blows right. It moves light and heavy objects alike and never moves fixed ones." },
          id: { type: "string", description: "For push and remove: the object id, such as box-1. Removing an object also removes any joint attached to it." },
          vx: { type: "number", description: "For push: horizontal speed, positive is right." },
          vy: { type: "number", description: "For push: vertical speed, negative is upward." }
        }
      },
      validate(args) {
        validateObject(args);
        if (!["set_gravity", "set_wind", "move", "push", "remove", "clear"].includes(args.action)) {
          throw toolError("action must be set_gravity, set_wind, move, push, remove, or clear.", "INVALID_ARGUMENT");
        }
        if (["push", "remove", "move"].includes(args.action) && (typeof args.id !== "string" || !args.id.trim())) {
          throw toolError("id is required to move, push, or remove an object.", "INVALID_ARGUMENT");
        }
        if (args.action === "move" && ![args.x, args.y].every((value) => Number.isFinite(Number(value)))) {
          throw toolError("move needs both x and y.", "INVALID_ARGUMENT");
        }
      },
      async execute(args) {
        if (!physicsService) throw toolError("The physics sandbox is unavailable in this build.", "CAPABILITY_UNAVAILABLE");
        return physicsService.apply(args.action, args);
      }
    },
    {
      name: "generate_uuid",
      description: "Generate one or more random version-4 UUIDs. Use when the user asks for a unique id, token, or UUID.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1, maximum: 50 } }
      },
      validate: validateObject,
      async execute(args) {
        const count = Math.max(1, Math.min(50, Number(args.count) || 1));
        return { count, uuids: Array.from({ length: count }, () => crypto.randomUUID()) };
      }
    },
    {
      name: "random_number",
      description: "Generate cryptographically-random numbers in an inclusive range. Use for dice rolls, sampling, or picking random values.",
      risk: "read",
      timeoutMs: 2_000,
      schema: {
        type: "object",
        properties: {
          min: { type: "number" },
          max: { type: "number" },
          count: { type: "integer", minimum: 1, maximum: 100 },
          integer: { type: "boolean", description: "Whole numbers only. Defaults to true." }
        }
      },
      validate: validateObject,
      async execute(args) {
        const min = Number.isFinite(Number(args.min)) ? Number(args.min) : 1;
        const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 100;
        if (min > max) throw toolError("min must be less than or equal to max.", "INVALID_ARGUMENT");
        const count = Math.max(1, Math.min(100, Number(args.count) || 1));
        const asInteger = args.integer !== false;
        let values;
        if (asInteger) {
          const lo = Math.ceil(min);
          const hi = Math.floor(max);
          if (lo > hi) throw toolError("No integer exists in the requested range.", "INVALID_ARGUMENT");
          values = Array.from({ length: count }, () => crypto.randomInt(lo, hi + 1));
        } else {
          values = Array.from({ length: count }, () => min + (crypto.randomInt(0, 2 ** 31) / 2 ** 31) * (max - min));
        }
        return { min, max, integer: asInteger, count, values };
      }
    }
  ];

  for (let index = 0; index < tools.length; index += 1) tools[index] = defineToolContract(tools[index]);
  for (const tool of tools) {
    if (!(tool.name in database.getToolConfig())) database.setToolConfig(tool.name, true, tool.risk);
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  function approvedMacros() {
    return database.listToolMacros().filter((macro) => macro.status === "approved");
  }

  function macroRisk(macro) {
    return macro.steps.some((step) => byName.get(step.tool)?.risk === "approval-write")
      ? "approval-write"
      : macro.steps.some((step) => byName.get(step.tool)?.risk === "network-read")
        ? "network-read" : "read";
  }

  // Runs a user-approved composite tool. Every inner step goes back through
  // registry.execute, so it is validated, time-limited, and audited like any
  // direct call; the macro itself gets its own audit record.
  async function runMacro(name, args, context) {
    const macro = database.getToolMacroByName(name.slice(MACRO_PREFIX.length));
    if (!macro || macro.status !== "approved") {
      return { runId: null, ok: false, output: JSON.stringify({ error: "Unknown tool.", code: "UNKNOWN_TOOL" }), durationMs: 0 };
    }
    if (!macro.enabled) {
      return { runId: null, ok: false, output: JSON.stringify({ error: "Tool is disabled.", code: "TOOL_DISABLED" }), durationMs: 0 };
    }
    const macroArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const runId = crypto.randomUUID();
    const started = Date.now();
    database.createToolRun({
      id: runId,
      conversationId: context.conversationId || null,
      messageId: context.messageId || null,
      toolName: name,
      arguments: serializedToolArguments(macroArgs),
      risk: macroRisk(macro),
      decision: "user-approved-macro",
      status: "running"
    });
    let result;
    try {
      const { signal } = createToolSignal(Math.min(300_000, Math.max(15_000, macro.steps.length * 20_000)), context.signal);
      result = await executeMacro({
        macro,
        args: macroArgs,
        signal,
        executeTool: (tool, stepArgs) => registry.execute(tool, stepArgs, { ...context, signal })
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      const cancelled = error?.name === "AbortError";
      result = { ok: false, error: timedOut ? "Macro timed out." : cancelled ? "Macro was cancelled." : error.message,
        code: timedOut ? "TIMEOUT" : cancelled ? "CANCELLED" : (error.code || "TOOL_ERROR") };
    }
    database.finishToolRun(runId, {
      status: result.pendingApproval ? "pending-approval" : result.ok ? "completed" : "failed",
      resultSummary: summarizeResult(result),
      error: result.ok ? "" : String(result.error || "").slice(0, 2000),
      durationMs: Date.now() - started
    });
    if (result.pendingApproval && approvalService) {
      const delegated = approvalService.getByToolRun(result.innerRunId);
      approvalService.create({
        kind: "tool-macro-effect",
        resourceType: "tool-macro-run",
        resourceId: runId,
        toolRunId: runId,
        conversationId: context.conversationId || null,
        agentRunId: context.agentRunId || null,
        summary: `Approve ${name}`,
        after: { pendingStep: result.pendingStep, steps: result.steps },
        metadata: { innerToolRunId: result.innerRunId || null, delegateApprovalId: delegated?.id || null }
      });
    }
    return {
      runId,
      ok: result.ok,
      output: capOutput(result),
      pendingApproval: Boolean(result.pendingApproval),
      durationMs: Date.now() - started
    };
  }

  const registry = {
    list() {
      const config = database.getToolConfig();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        timeoutMs: tool.timeoutMs,
        outputLimit: MAX_OUTPUT_CHARS,
        contractVersion: tool.contractVersion,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        riskPolicy: tool.riskPolicy,
        enabled: config[tool.name] !== false,
        permission: tool.permission || null,
        schema: tool.schema
      }));
    },
    schemas(context = {}) {
      const granted = Array.isArray(context.packPermissions) ? new Set(context.packPermissions) : null;
      const cloudProjectReadAllowed = !granted || context.providerId === "ollama" || granted.has("models.send-files");
      return [
        ...this.list().filter((tool) => tool.enabled
          && (!granted || !tool.permission || granted.has(tool.permission))
          && (tool.permission !== "filesystem.read.project" || cloudProjectReadAllowed)).map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        })),
        ...approvedMacros().filter((macro) => macro.enabled).map((macro) => ({
          type: "function",
          function: {
            name: `${MACRO_PREFIX}${macro.name}`,
            description: `${macro.title}. ${macro.description} Permission: ${macroRisk(macro)}.`.trim(),
            parameters: macroSchema(macro)
          }
        }))
      ];
    },
    builtinToolNames() {
      return new Set(tools.map((tool) => tool.name));
    },
    // Whether a call can run without pausing for a human. The chat loop uses
    // this to decide what may run alongside something else: an approval-gated
    // tool suspends the whole run, so it is never started concurrently with a
    // sibling whose result would then arrive after the run had already ended.
    // Unknown names answer false — refusing to parallelize is the safe guess.
    isAutomatic(name) {
      if (typeof name === "string" && name.startsWith(MACRO_PREFIX)) {
        const macro = database.getToolMacroByName(name.slice(MACRO_PREFIX.length));
        return Boolean(macro && macroRisk(macro) !== "approval-write");
      }
      return Boolean(byName.get(name)?.riskPolicy?.automatic);
    },
    requiresVault(name) {
      const vaultTools = new Set([
        "search_memory", "list_obsidian_notes", "search_obsidian", "read_obsidian_note", "get_obsidian_backlinks",
        "propose_obsidian_create", "propose_obsidian_edit", "propose_obsidian_move", "propose_obsidian_archive"
      ]);
      if (vaultTools.has(name)) return true;
      if (typeof name !== "string" || !name.startsWith(MACRO_PREFIX)) return false;
      const macro = database.getToolMacroByName(name.slice(MACRO_PREFIX.length));
      return Boolean(macro?.steps.some((step) => vaultTools.has(step.tool)));
    },
    setEnabled(name, enabled) {
      const tool = byName.get(name);
      if (!tool) throw Object.assign(new Error("Unknown tool."), { status: 404 });
      database.setToolConfig(name, Boolean(enabled), tool.risk);
      return this.list().find((item) => item.name === name);
    },
    dryRun(name, args, context = {}) {
      if (typeof name === "string" && name.startsWith(MACRO_PREFIX)) {
        const macro = database.getToolMacroByName(name.slice(MACRO_PREFIX.length));
        if (!macro || macro.status !== "approved" || !macro.enabled) {
          return { ok: false, executable: false, code: "TOOL_DISABLED", error: "Generated tool is unavailable." };
        }
        const missing = macro.inputs.filter((input) => input.required && !(input.name in (args || {}))).map((input) => input.name);
        if (missing.length) return { ok: false, executable: false, code: "INVALID_ARGUMENT", error: `Missing inputs: ${missing.join(", ")}` };
        return {
          ok: true, executable: false, contractVersion: 1, tool: name, risk: macroRisk(macro),
          approval: macroRisk(macro) === "approval-write" ? "per-effect" : "none",
          steps: macro.steps.map((step, index) => ({ index: index + 1, tool: step.tool, risk: byName.get(step.tool)?.risk || "read" })),
          note: "Structural dry run only. No macro step was executed."
        };
      }
      const tool = byName.get(name);
      if (!tool) return { ok: false, executable: false, code: "UNKNOWN_TOOL", error: "Unknown tool." };
      const configured = this.list().find((item) => item.name === name);
      const granted = !Array.isArray(context.packPermissions) || !tool.permission || context.packPermissions.includes(tool.permission);
      const result = dryRunToolContract(tool, args, { enabled: configured.enabled, policyAllowed: granted });
      database.audit("tool.dry-run", `Validated dry run for ${name}`, {
        entityType: "tool", entityId: name, metadata: { ok: result.ok, risk: tool.risk }
      });
      return result;
    },
    async execute(name, args, context = {}) {
      if (context.vaultAllowed === false && this.requiresVault(name)) {
        const runId = crypto.randomUUID();
        const macro = typeof name === "string" && name.startsWith(MACRO_PREFIX)
          ? database.getToolMacroByName(name.slice(MACRO_PREFIX.length)) : null;
        database.createToolRun({
          id: runId,
          conversationId: context.conversationId || null,
          messageId: context.messageId || null,
          toolName: name,
          arguments: serializedToolArguments(args),
          risk: macro ? macroRisk(macro) : byName.get(name)?.risk || "read",
          decision: "policy-denied",
          status: "failed"
        });
        database.finishToolRun(runId, {
          status: "failed",
          error: "VAULT_CLOUD_DISABLED: Vault tools are unavailable to this provider.",
          durationMs: 0
        });
        return {
          runId,
          ok: false,
          output: JSON.stringify({ error: "Vault memory is withheld from this provider.", code: "VAULT_CLOUD_DISABLED" }),
          durationMs: 0
        };
      }
      if (typeof name === "string" && name.startsWith(MACRO_PREFIX)) return runMacro(name, args, context);
      const tool = byName.get(name);
      if (!tool) {
        return {
          runId: null,
          ok: false,
          output: JSON.stringify({ error: "Unknown tool.", code: "UNKNOWN_TOOL" }),
          durationMs: 0
        };
      }
      const configured = this.list().find((item) => item.name === name);
      if (!configured.enabled) {
        return {
          runId: null,
          ok: false,
          output: JSON.stringify({ error: "Tool is disabled.", code: "TOOL_DISABLED" }),
          durationMs: 0
        };
      }
      const runId = crypto.randomUUID();
      const started = Date.now();
      if (Array.isArray(context.packPermissions) && tool.permission && !context.packPermissions.includes(tool.permission)) {
        database.createToolRun({ id: runId, conversationId: context.conversationId || null, messageId: context.messageId || null,
          toolName: name, arguments: serializedToolArguments(args), risk: tool.risk, decision: "policy-denied", status: "failed" });
        database.finishToolRun(runId, { status: "failed", error: `PACK_PERMISSION_DENIED: ${tool.permission}`, durationMs: 0 });
        return { runId, ok: false, output: JSON.stringify({ error: "The active pack was not granted this permission.", code: "PACK_PERMISSION_DENIED", permission: tool.permission }), durationMs: 0 };
      }
      if (Array.isArray(context.packPermissions) && context.providerId !== "ollama" && tool.permission === "filesystem.read.project"
        && !context.packPermissions.includes("models.send-files")) {
        database.createToolRun({ id: runId, conversationId: context.conversationId || null, messageId: context.messageId || null,
          toolName: name, arguments: serializedToolArguments(args), risk: tool.risk, decision: "policy-denied", status: "failed" });
        database.finishToolRun(runId, { status: "failed", error: "PACK_PERMISSION_DENIED: models.send-files", durationMs: 0 });
        return { runId, ok: false, output: JSON.stringify({ error: "Sending project file content to this cloud model was not approved.", code: "PACK_PERMISSION_DENIED", permission: "models.send-files" }), durationMs: 0 };
      }
      try {
        tool.validate(args);
      } catch (error) {
        database.createToolRun({
          id: runId,
          conversationId: context.conversationId || null,
          messageId: context.messageId || null,
          toolName: name,
          arguments: serializedToolArguments(args),
          risk: tool.risk,
          decision: "auto-approved",
          status: "failed"
        });
        database.finishToolRun(runId, {
          status: "failed",
          error: `${error.code || "INVALID_ARGUMENT"}: ${error.message}`,
          durationMs: Date.now() - started
        });
        return {
          runId,
          ok: false,
          output: JSON.stringify({ error: error.message, code: error.code || "INVALID_ARGUMENT" }),
          durationMs: Date.now() - started
        };
      }
      database.createToolRun({
        id: runId,
        conversationId: context.conversationId || null,
        messageId: context.messageId || null,
        toolName: name,
        arguments: serializedToolArguments(args),
        risk: tool.risk,
        decision: tool.risk === "approval-write" ? "approval-required" : "auto-approved",
        status: "running"
      });
      try {
        const { signal, timeoutSignal } = createToolSignal(tool.timeoutMs, context.signal);
        throwIfToolAborted(signal);
        const result = await tool.execute(args, { ...context, runId, signal });
        throwIfToolAborted(signal);
        const output = capOutput(result);
        database.finishToolRun(runId, {
          status: result?.approvalRequired ? "pending-approval" : "completed",
          resultSummary: summarizeResult(result),
          durationMs: Date.now() - started
        });
        if (result?.approvalRequired && approvalService && !approvalService.getByToolRun(runId)) {
          approvalService.create({
            kind: "tool-effect",
            resourceType: "tool-run",
            resourceId: runId,
            toolRunId: runId,
            conversationId: context.conversationId || null,
            agentRunId: context.agentRunId || null,
            summary: `Approve ${name}`,
            after: result,
            metadata: { timeoutSignalAborted: timeoutSignal.aborted }
          });
        }
        return { runId, ok: true, output, pendingApproval: Boolean(result?.approvalRequired), durationMs: Date.now() - started };
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.code === "TIMEOUT";
        const cancelled = error?.name === "AbortError" || error?.code === "CANCELLED";
        const normalizedCode = timedOut ? "TIMEOUT" : cancelled ? "CANCELLED" : (error.code || "TOOL_ERROR");
        const normalizedMessage = timedOut ? "Tool timed out." : cancelled ? "Tool execution was cancelled." : error.message;
        database.finishToolRun(runId, {
          status: "failed",
          error: `${normalizedCode}: ${normalizedMessage}`.slice(0, 2000),
          durationMs: Date.now() - started
        });
        return {
          runId,
          ok: false,
          output: JSON.stringify({ error: normalizedMessage, code: normalizedCode }),
          durationMs: Date.now() - started
        };
      }
    }
  };
  registry.decideEngineeringAction = engineeringActions ? (runId, decision) => engineeringActions.decide(runId, decision) : null;
  return registry;
}

export { ArithmeticParser };
