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
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "provider." } }] })}\n\n`);
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

test("custom providers reject private non-loopback endpoints", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-provider-url-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "provider.db"), defaultPrompt: "test" });
  const service = createProviderService({
    database,
    secretStore: { available: true, description: "test", encrypt: async (value) => value, decrypt: async (value) => value },
    ollamaUrl: "http://127.0.0.1:11434"
  });
  await assert.rejects(
    service.saveCredentials("custom", { apiKey: "12345678", baseUrl: "http://192.168.1.5/v1" }),
    (error) => error.code === "INVALID_BASE_URL" || error.code === "PRIVATE_ENDPOINT"
  );
  database.close();
  await rm(directory, { recursive: true, force: true });
});

test("a custom endpoint that later resolves privately is refused before the key is sent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-provider-rebind-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "provider.db"), defaultPrompt: "test" });
  // The first lookup is the save-time check and answers with a public address.
  // Every later lookup rebinds to loopback, which is what a DNS rebinding
  // attack against the stored endpoint looks like.
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  };
  let fetched = false;
  const service = createProviderService({
    database,
    secretStore: { available: true, description: "test", encrypt: async (value) => value, decrypt: async (value) => value },
    ollamaUrl: "http://127.0.0.1:11434",
    lookup
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetched = true; return originalFetch(...args); };
  try {
    await service.saveCredentials("custom", { apiKey: "12345678", baseUrl: "https://models.example/v1" });
    assert.equal(lookups, 1);
    await assert.rejects(service.models("custom"), (error) => error.code === "PRIVATE_ENDPOINT");
    assert.ok(lookups > 1, "the stored endpoint must be re-resolved at connect time");
    assert.equal(fetched, false, "no request may leave the machine once the endpoint resolves privately");
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
