import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, redactLogValue } from "../lib/logger.mjs";

test("structured logs redact secrets in fields, URLs, authorization headers, and errors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = createLogger({ dataDir: root, component: "test" });
  logger.error("provider.failed", {
    apiKey: "sk-super-secret-value",
    nested: { password: "hunter2", safe: "visible" },
    authorization: "Bearer abc.def.ghi",
    url: "https://example.test/?token=do-not-log",
    error: new Error("Request rejected for Bearer secret-token-value")
  });
  const contents = await readFile(logger.filePath, "utf8");
  const record = JSON.parse(contents.trim());
  assert.equal(record.level, "error");
  assert.equal(record.details.apiKey, "[REDACTED]");
  assert.equal(record.details.nested.password, "[REDACTED]");
  assert.equal(record.details.nested.safe, "visible");
  assert.equal(record.details.authorization, "[REDACTED]");
  assert.doesNotMatch(contents, /super-secret|hunter2|do-not-log|secret-token-value/);
});

test("structured logs rotate within a bounded file set", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-log-rotate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = createLogger({ dataDir: root, component: "rotate", maxBytes: 250, keepFiles: 3 });
  for (let index = 0; index < 10; index += 1) logger.info("rotation.test", { index, text: "x".repeat(100) });
  assert.equal(existsSync(logger.filePath), true);
  assert.equal(existsSync(`${logger.filePath}.1`), true);
  assert.equal(existsSync(`${logger.filePath}.2`), true);
  assert.equal(existsSync(`${logger.filePath}.3`), false);
});

test("redaction handles circular and binary diagnostic values", () => {
  const value = { buffer: Buffer.from("secret") };
  value.self = value;
  assert.deepEqual(redactLogValue(value), { buffer: "[binary:6]", self: "[CIRCULAR]" });
});
