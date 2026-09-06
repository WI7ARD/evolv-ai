import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createProviderService } from "../lib/providers.mjs";

// Installing a model left it out of the model list for five minutes.
//
// The provider model list is cached for 300 seconds. Health is not — it asks
// Ollama directly — so after installing Evolv Local the sidebar said "Evolv
// Local ready" while the model dropdown still served the list from before the
// install, and the model you had just waited to download could not be selected.
// Reported as "it's in but how do I use it, it's not in the dropdown".
//
// The cache was invalidated when credentials changed and when a key was
// rejected, but nothing invalidated it when the provider gained a model.

function stubOllama(models) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.5.7" }));
    if (req.url === "/api/tags") {
      return res.end(JSON.stringify({ models: models.current.map((name) => ({
        name, model: name, size: 2e9, digest: name,
        details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_0" }
      })) }));
    }
    res.end(JSON.stringify({ capabilities: ["completion"] }));
  });
  return server;
}

test("installing a model puts it in the list without waiting out the cache", async (t) => {
  const models = { current: ["llama3.2:3b"] };
  const server = stubOllama(models);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const database = {
    getProviderCredential: () => null,
    listModelPreferences: () => [],
    listModelHealth: () => [],
    setProviderStatus() {},
    saveProviderCredential() {},
    deleteProviderCredential() {}
  };
  const providers = createProviderService({ database, secretStore: null, ollamaUrl: url });

  const before = await providers.models("ollama");
  assert.deepEqual(before.map((m) => m.id), ["llama3.2:3b"]);

  // Ollama gains a model, exactly as an install does.
  models.current = ["llama3.2:3b", "evolv:latest"];

  // Without invalidation the cache hides it for five minutes.
  const stale = await providers.models("ollama");
  assert.deepEqual(stale.map((m) => m.id), ["llama3.2:3b"], "the cache is real, and this is what the user hit");

  providers.invalidateModels("ollama");
  const fresh = await providers.models("ollama");
  assert.deepEqual(fresh.map((m) => m.id), ["llama3.2:3b", "evolv:latest"], "after an install the new model is selectable at once");
});

test("the install route invalidates the list when it finishes", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("async function handleEvolvInstall");
  const body = server.slice(start, server.indexOf("\n}", start));
  assert.match(body, /providerService\.invalidateModels\("ollama"\)/,
    "an install that does not invalidate the model list leaves the new model unselectable");
});
