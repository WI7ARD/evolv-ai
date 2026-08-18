import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { createProviderService, GEMINI_API_REVISION } from "../lib/providers.mjs";

// A tool call, all the way from a provider's wire format to the shape the chat
// loop executes.
//
// This is the coverage that was missing, and its absence is why every test
// passed while tool calls did not work. test/streaming.test.mjs drives the real
// chat loop end to end, but only against Ollama. The OpenAI Responses and
// Gemini Interactions adapters were each tested against their own idea of what
// the provider sends — which is exactly the assumption that breaks when a
// provider changes shape, and tests written from the same assumption cannot
// notice.
//
// What is checked here is the seam: given bytes on a socket, does a tool call
// reach the caller with an id, a name, and arguments the registry can validate.

const sse = (events) => events.map(({ name, data }) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

async function withProviders(run) {
  const seen = [];
  const routes = new Map();
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const handler = [...routes.entries()].find(([pattern]) => req.url.includes(pattern))?.[1];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    return handler(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const directory = await mkdtemp(path.join(tmpdir(), "evolv-toolflow-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "t.db"), defaultPrompt: "test" });
  const secretStore = {
    available: true,
    description: "test",
    encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString()
  };
  const service = createProviderService({
    database,
    secretStore,
    ollamaUrl: "http://127.0.0.1:11434",
    providerBaseUrls: { openai: `${origin}/openai`, gemini: `${origin}/gemini` }
  });
  await service.saveCredentials("openai", { apiKey: "sk-test-key-0000" });
  await service.saveCredentials("gemini", { apiKey: "gm-test-key-0000" });

  try {
    await run({ service, routes, seen });
  } finally {
    database.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const PAYLOAD = {
  model: "m1",
  messages: [{ role: "user", content: "what is 2+2" }],
  tools: [{
    type: "function",
    function: { name: "calculate", description: "arithmetic", parameters: { type: "object", properties: { expression: { type: "string" } } } }
  }],
  options: { maxTokens: 512 }
};

function collect(service, providerId) {
  const chunks = [];
  return service.streamRound(providerId, PAYLOAD, undefined, (chunk) => chunks.push(chunk)).then(() => chunks);
}

test("an OpenAI Responses function call arrives as a runnable tool call", async () => {
  await withProviders(async ({ service, routes }) => {
    routes.set("/responses", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { name: "response.output_item.done", data: { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "calculate", arguments: '{"expression":"2+2"}' } } },
        { name: "response.completed", data: { response: { id: "resp_1", status: "completed" } } }
      ]));
    });

    const chunks = await collect(service, "openai");
    const calls = chunks.flatMap((chunk) => chunk.message?.tool_calls || []);
    assert.equal(calls.length, 1, "a function_call item must become exactly one tool call");
    assert.equal(calls[0].id, "call_1");
    assert.equal(calls[0].function.name, "calculate");
    // The chat loop parses a string, so either shape is fine — what is not fine
    // is losing the arguments.
    const args = typeof calls[0].function.arguments === "string"
      ? JSON.parse(calls[0].function.arguments) : calls[0].function.arguments;
    assert.deepEqual(args, { expression: "2+2" });
    // And the provider's own item is kept, which is what makes the second round
    // work rather than fail on a missing field.
    assert.ok(calls[0].providerState?.openaiItem, "the raw item must travel with the call");
    assert.ok(chunks.some((chunk) => chunk.done), "the round has to end");
  });
});

test("a Gemini Interactions function call arrives as a runnable tool call, signature intact", async () => {
  await withProviders(async ({ service, routes, seen }) => {
    routes.set("/interactions", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { name: "step.start", data: { index: 0, step: { type: "function_call", id: "call_1", name: "calculate" } } },
        { name: "step.stop", data: { index: 0, step: { type: "function_call", id: "call_1", name: "calculate", arguments: { expression: "2+2" } } } },
        { name: "step.stop", data: { index: 1, step: { type: "thought", signature: "sig-abc", summary: [{ type: "text", text: "adding" }] } } },
        { name: "interaction.completed", data: { interaction: { id: "int_1", status: "completed" } } }
      ]));
    });

    const chunks = await collect(service, "gemini");
    const calls = chunks.flatMap((chunk) => chunk.message?.tool_calls || []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call_1");
    assert.equal(calls[0].function.name, "calculate");
    // The signature rides on a `thought` step in this API, not on the call —
    // that is a legacy generateContent field — and it has to be kept, because
    // the next round replays it.
    const thought = chunks.map((chunk) => chunk.providerState?.geminiStep).find((step) => step?.type === "thought");
    assert.equal(thought?.signature, "sig-abc", "the signature has to survive the round trip");

    // The revision this adapter is written against is pinned on the request.
    const chat = seen.find((entry) => entry.url.includes("/interactions"));
    assert.equal(chat.headers["api-revision"], GEMINI_API_REVISION,
      "an unpinned API is a promise that someone else's release schedule will not break you");
  });
});

test("a provider that changed shape says so instead of returning an empty turn", async () => {
  // This is the failure that hides. An adapter reading events with an if/else
  // chain and no final else discards everything it does not recognise, so a
  // renamed event type produces a turn with no text, no tool call, and no
  // error — and nothing anywhere says why the tool call never happened.
  await withProviders(async ({ service, routes }) => {
    routes.set("/responses", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { name: "response.v2.item.finished", data: { item: { type: "function_call", name: "calculate" } } },
        { name: "response.v2.finished", data: { status: "completed" } }
      ]));
    });
    await assert.rejects(() => collect(service, "openai"), (error) => {
      assert.equal(error.code, "PROVIDER_STREAM_UNRECOGNIZED");
      assert.match(error.message, /understood none of them/);
      // The event names are the one thing needed to fix it, so they are in the
      // message rather than only in a log.
      assert.match(error.message, /response\.v2\.item\.finished/);
      assert.equal(error.expose, true, "and it reaches the person, not a reference number");
      return true;
    });

    routes.set("/interactions", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { name: "interaction.output.delta", data: { text: "hello" } },
        { name: "interaction.done", data: {} }
      ]));
    });
    await assert.rejects(() => collect(service, "gemini"), (error) => {
      assert.equal(error.code, "PROVIDER_STREAM_UNRECOGNIZED");
      assert.match(error.message, /interaction\.output\.delta/);
      return true;
    });
  });
});

test("a provider that answers nothing at all is not reported as a schema change", async () => {
  // An empty stream is a different problem — the model declined to say
  // anything — and dressing it up as "the API changed" would send someone
  // hunting a migration guide over a model that simply returned nothing.
  await withProviders(async ({ service, routes }) => {
    routes.set("/responses", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("");
    });
    const chunks = await collect(service, "openai");
    assert.deepEqual(chunks, []);
  });
});

test("text-only turns still count as understood", async () => {
  // The witness must not fire on a perfectly ordinary answer that happens to
  // contain no tool call.
  await withProviders(async ({ service, routes }) => {
    routes.set("/responses", (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { name: "response.output_text.delta", data: { delta: "four" } },
        { name: "response.completed", data: { response: { status: "completed" } } }
      ]));
    });
    const chunks = await collect(service, "openai");
    assert.equal(chunks.map((chunk) => chunk.message?.content || "").join(""), "four");
  });
});
