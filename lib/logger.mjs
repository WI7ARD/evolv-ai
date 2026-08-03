import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEY = /(?:authorization|cookie|csrf|credential|password|passwd|recovery|secret|session|token|api[_-]?key|private[_-]?key)/i;
const MAX_DEPTH = 8;
const MAX_STRING = 4_000;

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|rk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "$1-[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .slice(0, MAX_STRING);
}

export function redactLogValue(value, key = "", seen = new WeakSet(), depth = 0) {
  if (SENSITIVE_KEY.test(String(key))) return "[REDACTED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (value instanceof Error) {
    return {
      name: redactString(value.name || "Error"),
      message: redactString(value.message || "Unexpected error"),
      ...(value.code ? { code: redactString(value.code) } : {}),
      ...(value.stack ? { stack: redactString(value.stack) } : {})
    };
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[binary:${value.byteLength}]`;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactLogValue(item, "", seen, depth + 1));
  const output = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 100)) {
    output[entryKey] = redactLogValue(entryValue, entryKey, seen, depth + 1);
  }
  return output;
}

function rotateLogs(filePath, keepFiles) {
  for (let index = keepFiles - 1; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const destination = `${filePath}.${index}`;
    if (!fs.existsSync(source)) continue;
    try {
      fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    } catch {
      // Logging must never interrupt the application.
    }
  }
}

export function createLogger({ dataDir, component = "app", maxBytes = 5 * 1024 * 1024, keepFiles = 5 } = {}) {
  const safeComponent = String(component).replace(/[^a-z0-9._-]/gi, "-").slice(0, 40) || "app";
  const logsDir = path.join(dataDir, "logs");
  const filePath = path.join(logsDir, `${safeComponent}.jsonl`);
  fs.mkdirSync(logsDir, { recursive: true });

  function write(level, event, details = {}) {
    try {
      const record = {
        timestamp: new Date().toISOString(),
        level,
        component: safeComponent,
        event: redactString(event || "application.event"),
        details: redactLogValue(details)
      };
      const line = `${JSON.stringify(record)}\n`;
      let currentSize = 0;
      try { currentSize = fs.statSync(filePath).size; } catch {}
      if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxBytes) rotateLogs(filePath, Math.max(1, keepFiles));
      fs.appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // A diagnostic failure cannot become an application failure.
    }
  }

  return Object.freeze({
    filePath,
    debug: (event, details) => write("debug", event, details),
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details)
  });
}
