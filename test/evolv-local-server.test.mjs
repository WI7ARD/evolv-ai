import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMockOllama } from "./helpers/mock-ollama.mjs";
import { createAuthenticatedClient } from "./helpers/auth-client.mjs";

// The whole first run, end to end, against an Ollama that starts empty: the
// state Evolv used to call "connected" and then fail on.
const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let mock;
let dataDir;
let client;

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "evolv-local-"));
  mock = await startMockOllama({ models: [] });
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OLLAMA_URL: mock.url,
      EVOLV_DATA_DIR: dataDir,
      EVOLV_DB_PATH: path.join(dataDir, "test.db"),
      EVOLV_SCRYPT_N: "1024"
    },
    stdio: "ignore"
  });
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      ready = (await fetch(`${BASE}/api/auth/status`)).ok;
    } catch {}
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error("Server did not become ready.");
  client = await createAuthenticatedClient(BASE);
});

test.after(async () => {
  child?.kill();
  await delay(150);
  await mock?.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test("health reports a running Ollama with nothing installed as not ready", async () => {
  const health = await (await client.fetch("/api/health")).json();

  // `connected` keeps its old meaning so nothing that already reads it breaks.
  assert.equal(health.connected, true);
  assert.equal(health.ollamaReachable, true);
  assert.equal(health.modelCount, 0);
  assert.deepEqual(health.models, []);
  assert.equal(health.evolvModelInstalled, false);
  assert.equal(health.evolvModel, "evolv:latest");
});

test("the status endpoint answers the same question on its own", async () => {
  const status = await (await client.fetch("/api/ollama/status")).json();

  assert.equal(status.ollamaReachable, true);
  assert.equal(status.evolvModelInstalled, false);
  assert.equal(status.baseModelInstalled, false);
  assert.equal(status.install.phase, "idle");
});

test("installing streams real progress, builds evolv:latest, and reports ready", async () => {
  const response = await client.fetch("/api/ollama/install-evolv", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);

  const events = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const phases = [...new Set(events.map((event) => event.phase))];
  assert.deepEqual(phases, ["checking", "pulling", "creating", "ready"]);

  // Percentages come from the byte counts the mock reports, layer by layer.
  const percents = events.filter((event) => event.phase === "pulling" && typeof event.percent === "number").map((event) => event.percent);
  assert.deepEqual([...new Set(percents)], [20, 60, 100], "the bar tracks the download rather than a timer");
  assert.ok(percents.every((value, index) => index === 0 || value >= percents[index - 1]), "and never runs backwards");
  assert.equal(events.at(-1).phase, "ready");

  assert.deepEqual(mock.pullRequests.map((request) => request.model), ["llama3.2:3b"]);
  assert.equal(mock.createRequests.length, 1);
  assert.equal(mock.createRequests[0].model, "evolv:latest");
  // The system prompt has to reach Ollama, or the model is just the base model
  // wearing Evolv's name.
  assert.match(mock.createRequests[0].system, /You are Evolv Local/);
});

test("after installing, Evolv recognises Evolv Local on the next start", async () => {
  // The same question a restarted app asks: no state carried over from the
  // install, just Ollama's own model list.
  const health = await (await client.fetch("/api/health")).json();

  assert.equal(health.evolvModelInstalled, true);
  assert.equal(health.baseModelInstalled, true);
  assert.ok(health.modelCount >= 2);
  assert.ok(health.models.includes("evolv:latest"));
});

test("the model list the interface reads includes the new model", async () => {
  const { models } = await (await client.fetch("/api/models?provider=ollama&refresh=true")).json();
  assert.ok(models.some((model) => model.name === "evolv:latest"), "the selector has something to select");
});

test("a second install of an already-installed model does not download again", async () => {
  const before = mock.pullRequests.length;
  const response = await client.fetch("/api/ollama/install-evolv", { method: "POST", body: "{}" });
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(events.at(-1).phase, "ready");
  assert.equal(mock.pullRequests.length, before, "the base model was already there");
});
