import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { classifyModelFailure, healthLabel, FAILURES_BEFORE_WARNING } from "../lib/model-health.mjs";

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-health-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "h.db"), defaultPrompt: "test" });
  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("only the model's own failures are blamed on the model", () => {
  for (const message of [
    "model 'llama3:70b' not found, try pulling it first",
    "model requires more system memory (42.0 GiB) than is available (15.6 GiB)",
    "registry.ollama.ai/library/x does not support tools",
    "This model's maximum context length is 8192 tokens"
  ]) {
    assert.equal(classifyModelFailure(message).blame, "model", message);
    assert.ok(classifyModelFailure(message).reason, "a blamed model needs a reason to show");
  }
});

test("a provider that is down does not mark every model broken", () => {
  // The failure that would otherwise fill the list with warnings: Ollama shut
  // down fails every model at once, and none of them is at fault.
  for (const message of [
    "fetch failed",
    "connect ECONNREFUSED 127.0.0.1:11434",
    "401 Unauthorized: invalid api key",
    "429 rate limit exceeded"
  ]) {
    assert.equal(classifyModelFailure(message).blame, "environment", message);
  }
});

test("stopping a reply is not a failure, and an unfamiliar error is not pinned on the model", () => {
  assert.equal(classifyModelFailure("The operation was aborted").blame, "none");
  // A first sighting of an unrecognised message is a poor reason to start
  // warning people away from a model that may well work.
  assert.equal(classifyModelFailure("something nobody has seen before").blame, "unknown");
  assert.equal(classifyModelFailure("").blame, "unknown");
});

test("one failure is a bad moment; two in a row is a pattern worth showing", () => {
  assert.equal(healthLabel({ failures: 1, reason: "not installed" }), "");
  assert.match(healthLabel({ failures: FAILURES_BEFORE_WARNING, reason: "not installed" }), /not installed/);
  assert.equal(healthLabel(null), "");
});

test("failures accumulate per model and a success clears them", async () => {
  await withDatabase((database) => {
    database.recordModelResult({ provider: "ollama", model: "big:70b", ok: false, reason: "needs more memory" });
    const twice = database.recordModelResult({ provider: "ollama", model: "big:70b", ok: false, reason: "needs more memory" });
    assert.equal(twice.failures, 2);
    assert.equal(twice.reason, "needs more memory");

    // Another model is unaffected — the record is per model, not per provider.
    assert.equal(database.getModelHealth("ollama", "evolv:latest"), null);

    // A model that answers is working now, whatever it did yesterday.
    const recovered = database.recordModelResult({ provider: "ollama", model: "big:70b", ok: true });
    assert.equal(recovered.failures, 0);
    assert.equal(recovered.reason, "");
    assert.ok(recovered.lastOkAt);
  });
});

test("the same model name from two providers is tracked separately", async () => {
  await withDatabase((database) => {
    database.recordModelResult({ provider: "ollama", model: "gpt-oss:20b", ok: false, reason: "not installed" });
    database.recordModelResult({ provider: "openrouter", model: "gpt-oss:20b", ok: true });

    assert.equal(database.getModelHealth("ollama", "gpt-oss:20b").failures, 1);
    assert.equal(database.getModelHealth("openrouter", "gpt-oss:20b").failures, 0);
    assert.deepEqual(database.listModelHealth("ollama").map((row) => row.model), ["gpt-oss:20b"]);
  });
});

test("a result with no provider or no model is not recorded at all", async () => {
  await withDatabase((database) => {
    assert.equal(database.recordModelResult({ provider: "", model: "x", ok: false }), null);
    assert.equal(database.recordModelResult({ provider: "ollama", model: "", ok: false }), null);
    assert.deepEqual(database.listModelHealth("ollama"), []);
  });
});

test("the chat path records what happened and the list shows it", async () => {
  const [server, app] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  // Recorded on both outcomes, or the record only ever gets worse.
  assert.match(server, /recordModelResult\(\{ provider: providerId, model: selectedModel, ok: true \}\)/);
  assert.match(server, /classifyModelFailure\(error\.message\)/);
  assert.match(server, /blame\.blame === "model"/);
  // An interrupted generation is the person's choice, not the model failing.
  assert.match(server, /if \(!runInterrupted\) \{/);

  assert.match(app, /model\.health\?\.failing/);
});
