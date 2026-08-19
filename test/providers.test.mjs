import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { createProviderService } from "../lib/providers.mjs";

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-chat", name: "Mock Chat" }] }));
      return;
    }
    // OpenAI speaks the Responses API.
    // chat-completions, which is what they actually implement.
    if (req.url === "/v1/responses" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      sse({ type: "response.output_text.delta", delta: "Hello " });
      sse({ type: "response.output_text.delta", delta: "provider." });
      sse({ type: "response.completed", response: { status: "completed" } });
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("provider credentials are encrypted at rest and never exported", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-provider-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "provider.db"), defaultPrompt: "test" });
  const secretStore = {
    available: true,
    description: "test",
    async encrypt(value) { return Buffer.from([...value].reverse().join("")).toString("base64"); },
    async decrypt(value) { return [...Buffer.from(value, "base64").toString()].reverse().join(""); }
  };
  const service = createProviderService({
    database,
    secretStore,
    ollamaUrl: "http://127.0.0.1:11434",
    providerBaseUrls: { openai: baseUrl }
  });
  await service.saveCredentials("openai", { apiKey: "sk-test-super-secret" });
  const stored = database.getProviderCredential("openai");
  assert.ok(stored.encryptedSecret);
  assert.ok(!stored.encryptedSecret.includes("sk-test-super-secret"));
  assert.ok(!JSON.stringify(database.exportData()).includes("sk-test-super-secret"));
  assert.ok(!JSON.stringify(service.list()).includes("sk-test-super-secret"));
  const models = await service.models("openai");
  assert.equal(models[0].id, "mock-chat");
  let content = "";
  await service.streamRound("openai", {
    model: "mock-chat",
    messages: [{ role: "user", content: "hi" }],
    options: { temperature: 0 }
  }, AbortSignal.timeout(5000), (chunk) => {
    content += chunk.message?.content || "";
  });
  assert.equal(content, "Hello provider.");
  database.close();
  await rm(directory, { recursive: true, force: true });
});

test("models that cannot chat never reach the model picker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-chatonly-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "p.db"), defaultPrompt: "test" });
  const secretStore = { available: true, description: "t", async encrypt(v) { return v; }, async decrypt(v) { return v; } };

  const catalogue = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // The shape OpenAI actually returns: everything the key can touch.
    res.end(JSON.stringify({ data: [
      { id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o3-mini" }, { id: "gpt-4o-audio-preview" },
      { id: "dall-e-3" }, { id: "whisper-1" }, { id: "tts-1" }, { id: "text-embedding-3-small" },
      { id: "omni-moderation-latest" }, { id: "davinci-002" }, { id: "gpt-3.5-turbo-instruct" },
      { id: "gpt-4o-realtime-preview" }
    ] }));
  });
  await new Promise((resolve) => catalogue.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${catalogue.address().port}/v1`;

  const service = createProviderService({ database, secretStore, ollamaUrl: "http://127.0.0.1:11434", providerBaseUrls: { openai: url } });
  try {
  await service.saveCredentials("openai", { apiKey: "sk-test-key-value" });
  const offered = (await service.models("openai")).map((model) => model.id);

  assert.deepEqual(offered, ["gpt-4o", "gpt-4o-mini", "o3-mini", "gpt-4o-audio-preview"]);
  // Audio *preview* is a chat model despite the name; excluding it would be a
  // real model missing from the dropdown.
  assert.ok(offered.includes("gpt-4o-audio-preview"));
  for (const rejected of ["dall-e-3", "whisper-1", "tts-1", "text-embedding-3-small", "davinci-002", "gpt-4o-realtime-preview"]) {
    assert.ok(!offered.includes(rejected), `${rejected} cannot chat and must not be offered`);
  }

  } finally {
    catalogue.closeAllConnections();
    await new Promise((resolve) => catalogue.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed provider call repeats what the provider actually said", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-detail-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "p.db"), defaultPrompt: "test" });
  const secretStore = { available: true, description: "t", async encrypt(v) { return v; }, async decrypt(v) { return v; } };

  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "The model `gpt-4o` does not exist or you do not have access to it.", code: "model_not_found" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${upstream.address().port}/v1`;

  const service = createProviderService({ database, secretStore, ollamaUrl: "http://127.0.0.1:11434", providerBaseUrls: { openai: url } });
  try {
  await service.saveCredentials("openai", { apiKey: "sk-test-key-value" });

  // "OpenAI chat failed (404)" is a dead end. The provider already explained
  // itself; the only job here is not to throw that explanation away.
  await assert.rejects(
    () => service.streamRound("openai", {
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }], options: { temperature: 0 }
    }, AbortSignal.timeout(5000), () => {}),
    (error) => {
      assert.match(error.message, /does not exist or you do not have access/);
      assert.match(error.message, /404/);
      return true;
    }
  );

  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider that cannot be reached says so instead of raising a server error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-unreachable-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "u.db"), defaultPrompt: "test" });
  const secretStore = { available: true, description: "t", async encrypt(v) { return v; }, async decrypt(v) { return v; } };

  // A port nothing is listening on: exactly a first run with Ollama not started.
  const dead = "http://127.0.0.1:1";
  const service = createProviderService({ database, secretStore, ollamaUrl: dead });

  try {
    // Before this was handled, the refused connection escaped as a bare
    // TypeError with no status, and the request handler turned it into
    // "Unexpected server error. Reference: <uuid>" — the first thing a new
    // user saw, and it told them nothing they could act on.
    await assert.rejects(
      () => service.models("ollama"),
      (error) => {
        assert.equal(error.code, "PROVIDER_UNREACHABLE");
        // 503 specifically: the request handler exposes messages on 4xx and
        // 503 only, so any other status would hide this text again.
        assert.equal(error.status, 503);
        assert.match(error.message, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:1\./);
        assert.match(error.message, /Start Ollama, then refresh\./);
        return true;
      }
    );

    // A cloud provider is a different problem and gets different advice.
    await service.saveCredentials("openai", { apiKey: "sk-test-key-value" });
    const cloud = createProviderService({
      database, secretStore, ollamaUrl: dead, providerBaseUrls: { openai: dead }
    });
    await assert.rejects(
      () => cloud.models("openai"),
      (error) => {
        assert.equal(error.code, "PROVIDER_UNREACHABLE");
        assert.match(error.message, /Cannot reach OpenAI\./);
        assert.match(error.message, /internet connection/);
        return true;
      }
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
