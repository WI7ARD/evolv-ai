import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { createProviderService } from "../lib/providers.mjs";

// A single mock endpoint stands in for Anthropic, Gemini, and OpenRouter. Each
// provider is routed under its own path prefix so the discovery and chat shapes
// can differ per vendor while sharing one server. Every request is recorded so
// the tests can assert the provider-specific authentication headers.
const requests = [];
const attempts = new Map();
let server;
let origin;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : "";
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    // Anthropic — OpenAI-shaped /models list, native /messages SSE stream.
    if (req.url === "/anthropic/models") {
      return json(200, { data: [{ id: "claude-4-sonnet" }, { id: "claude-3-5-haiku" }] });
    }
    if (req.url === "/anthropic/messages" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      sse({ type: "message_start", message: { id: "msg_1" } });
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason." } });
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi from " } });
      res.write("data: {not valid json\n\n"); // must be skipped, not fatal
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Claude." } });
      sse({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "calculator" } });
      sse({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"expres" } });
      sse({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "sion\":\"2+2\"}" } });
      sse({ type: "content_block_stop", index: 2 });
      sse({ type: "message_stop" });
      return res.end("data: [DONE]\n\n");
    }

    // OpenRouter — OpenAI-shaped list with capability metadata, SSE chat.
    if (req.url === "/openrouter/models") {
      return json(200, { data: [{
        id: "anthropic/claude-3.5-sonnet",
        supported_parameters: ["tools", "reasoning"],
        architecture: { input_modalities: ["text", "image"] }
      }] });
    }
    if (req.url === "/openrouter/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Thinking… " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Routed " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "reply." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0, id: "call_1", function: { name: "calculator", arguments: "{\"expression\":\"2+2\"}" }
      }] } }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }

    // OpenAI â€” reject optional parameters once so the compatibility retry is
    // exercised, and expose a model-specific rejection for fallback testing.
    if (req.url === "/openai/models") {
      return json(200, { data: [
        { id: "gpt-compat" }, { id: "gpt-replacement" }, { id: "gpt-transient" },
        { id: "text-embedding-3-small" }, { id: "gpt-4o-realtime-preview" }
      ] });
    }
    if (req.url === "/openai/responses" && req.method === "POST") {
      const parsed = JSON.parse(body || "{}");
      const count = (attempts.get(parsed.model) || 0) + 1;
      attempts.set(parsed.model, count);
      if (parsed.model === "gpt-unavailable") {
        return json(400, { error: { message: "This model has been retired and is not available." } });
      }
      if (parsed.model === "gpt-transient" && count === 1) {
        return json(503, { error: { message: "Temporarily unavailable" } });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Reliable OpenAI reply." })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 4 } } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }

    // Gemini — models list gated by supportedGenerationMethods, generateContent chat.
    if (req.url === "/gemini/models") {
      if (req.headers["x-goog-api-key"] === "revoked-gemini-key") {
        return json(400, {
          error: {
            message: "API key not valid. Please pass a valid API key.",
            details: [{ reason: "API_KEY_INVALID" }]
          }
        });
      }
      return json(200, { models: [
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }
      ] });
    }
    if (req.url === "/gemini/interactions" && req.method === "POST") {
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      sse({ event_type: "step.delta", step_id: "text_1", delta: { type: "text", text: "Hi from " } });
      sse({ event_type: "step.delta", step_id: "text_1", delta: { type: "text", text: "Gemini." } });
      if (parsed.tools?.length) {
        const step = { type: "function_call", id: "step_calc", call_id: "call_calc", name: "calculator", arguments: { expression: "2+2" } };
        sse({ event_type: "step.start", index: 1, step: { type: "function_call", id: step.id, name: step.name } });
        sse({ event_type: "step.delta", index: 1, delta: { type: "arguments", partial_arguments: JSON.stringify(step.arguments) } });
        sse({ event_type: "step.stop", index: 1, status: "waiting" });
      }
      sse({ event_type: "interaction.completed", interaction: { status: "completed", usage: { input_tokens: 3, output_tokens: 3 } } });
      return res.end();
    }

    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function withService(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-cloud-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "cloud.db"), defaultPrompt: "test" });
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
    providerBaseUrls: {
      anthropic: `${origin}/anthropic`,
      openrouter: `${origin}/openrouter`,
      openai: `${origin}/openai`,
      gemini: `${origin}/gemini`
    }
  });
  try {
    await run(service);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function lastRequest(match) {
  return [...requests].reverse().find((entry) => match(entry.url));
}

test("Anthropic discovery, capabilities, and native message streaming", async () => {
  await withService(async (service) => {
    await service.saveCredentials("anthropic", { apiKey: "sk-ant-test-key" });

    const models = await service.models("anthropic");
    const sonnet = models.find((model) => model.id === "claude-4-sonnet");
    const haiku = models.find((model) => model.id === "claude-3-5-haiku");
    assert.deepEqual(sonnet.capabilities, ["completion", "tools", "vision", "thinking"]);
    assert.equal(sonnet.supportsThinking, true);
    assert.ok(!haiku.capabilities.includes("thinking"), "older Claude models advertise no thinking");

    const listRequest = lastRequest((url) => url === "/anthropic/models");
    assert.equal(listRequest.headers["x-api-key"], "sk-ant-test-key");
    assert.equal(listRequest.headers["anthropic-version"], "2023-06-01");

    const chunks = [];
    await service.streamRound("anthropic", {
      model: "claude-4-sonnet",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }],
      options: { temperature: 0, maxTokens: 8192 }
    }, AbortSignal.timeout(5000), (event) => chunks.push(event));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Hi from Claude.");
    assert.ok(chunks.filter((event) => event.type === "text.delta").length >= 2, "text arrives as incremental deltas");
    assert.equal(chunks.filter((event) => event.type === "reasoning.delta").map((event) => event.delta).join(""), "Let me reason.");
    const toolCall = chunks.find((event) => event.type === "tool.call");
    assert.equal(toolCall.name, "calculator");
    assert.deepEqual(toolCall.arguments, { expression: "2+2" }, "tool input reassembled from input_json_delta");

    const chatRequest = lastRequest((url) => url === "/anthropic/messages");
    const chatBody = JSON.parse(chatRequest.body);
    assert.equal(chatBody.system, "Be brief.");
    assert.equal(chatBody.messages[0].content[0].text, "hi");
    assert.equal(chatBody.stream, true, "Anthropic requests native streaming");
    assert.equal(chatBody.max_tokens, 8192, "configured max tokens reaches the provider");
  });
});

test("OpenRouter discovery reads capability metadata and streams SSE with reasoning", async () => {
  await withService(async (service) => {
    await service.saveCredentials("openrouter", { apiKey: "sk-or-test-key" });

    const models = await service.models("openrouter");
    assert.equal(models[0].id, "anthropic/claude-3.5-sonnet");
    assert.deepEqual(models[0].capabilities, ["completion", "tools", "vision", "thinking"]);

    const listRequest = lastRequest((url) => url === "/openrouter/models");
    assert.equal(listRequest.headers.authorization, "Bearer sk-or-test-key");

    const chunks = [];
    await service.streamRound("openrouter", {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0 }
    }, AbortSignal.timeout(5000), (event) => chunks.push(event));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Routed reply.");
    assert.equal(chunks.filter((event) => event.type === "reasoning.delta").map((event) => event.delta).join(""), "Thinking… ");
    const toolCall = chunks.find((event) => event.type === "tool.call");
    assert.equal(toolCall.name, "calculator");
    assert.deepEqual(toolCall.arguments, { expression: "2+2" });
  });
});

test("OpenAI uses the Responses API, stateless storage, native tools, and filters non-chat models", async () => {
  await withService(async (service) => {
    await service.saveCredentials("openai", { apiKey: "sk-openai-test-key" });
    const models = await service.models("openai");
    assert.ok(models.some((model) => model.id === "gpt-compat"));
    assert.ok(!models.some((model) => /embedding|realtime/i.test(model.id)), "non-chat models are hidden");

    const chunks = [];
    await service.streamRound("openai", {
      model: "gpt-compat",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "calculate", description: "Calculate", parameters: { type: "object", properties: {} } } }],
      format: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      options: { temperature: 0.4 }
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Reliable OpenAI reply.");
    const responseRequests = requests.filter((item) => item.url === "/openai/responses" && JSON.parse(item.body).model === "gpt-compat");
    assert.equal(responseRequests.length, 1);
    const request = JSON.parse(responseRequests[0].body);
    assert.equal(request.store, false);
    assert.equal(request.tools[0].name, "calculate");
    assert.equal("temperature" in request, false);
    assert.equal(request.text.format.type, "json_schema");
  });
});

test("provider failures preserve safe detail, classify unavailable models, and retry temporary errors once", async () => {
  await withService(async (service) => {
    await service.saveCredentials("openai", { apiKey: "sk-openai-test-key" });
    await assert.rejects(
      service.streamRound("openai", {
        model: "gpt-unavailable", messages: [{ role: "user", content: "hi" }], options: { temperature: 0 }
      }, AbortSignal.timeout(5000), () => {}),
      (error) => error.code === "MODEL_UNAVAILABLE" && /retired/i.test(error.message)
    );
    assert.equal((await service.alternativeModel("openai", "gpt-unavailable")).id, "gpt-compat");

    const chunks = [];
    await service.streamRound("openai", {
      model: "gpt-transient", messages: [{ role: "user", content: "retry" }], options: {}
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Reliable OpenAI reply.");
    assert.equal(attempts.get("gpt-transient"), 2);
  });
});

test("Gemini filters non-chat models and streams native Interactions events", async () => {
  await withService(async (service) => {
    await service.saveCredentials("gemini", { apiKey: "test-gemini-key" });

    const models = await service.models("gemini");
    assert.equal(models.length, 1, "the embedding-only model is excluded");
    assert.equal(models[0].id, "gemini-2.5-pro");
    assert.ok(models[0].capabilities.includes("thinking"), "Gemini 2.5 advertises thinking");

    const listRequest = lastRequest((url) => url === "/gemini/models");
    assert.equal(listRequest.headers["x-goog-api-key"], "test-gemini-key");

    const chunks = [];
    await service.streamRound("gemini", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "calculator", description: "Calculate", parameters: { type: "object", properties: {} } } }],
      options: { temperature: 0 }
    }, AbortSignal.timeout(5000), (event) => chunks.push(event));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Hi from Gemini.");
    assert.ok(chunks.filter((event) => event.type === "text.delta").length >= 2, "text arrives as incremental deltas");
    const toolCall = chunks.find((event) => event.type === "tool.call");
    assert.equal(toolCall.name, "calculator");
    assert.deepEqual(toolCall.arguments, { expression: "2+2" });

    const chatRequest = lastRequest((url) => url === "/gemini/interactions");
    assert.equal(JSON.parse(chatRequest.body).store, false);
    assert.equal(JSON.parse(chatRequest.body).tools[0].name, "calculator");
  });
});

test("Gemini sends tools and structured output through Interactions without legacy schema fallback", async () => {
  await withService(async (service) => {
    await service.saveCredentials("gemini", { apiKey: "test-gemini-key" });
    const chunks = [];
    await service.streamRound("gemini", {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "calculate", description: "Calculate", parameters: { type: "object", properties: {} } } }],
      format: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      options: { temperature: 0.2 }
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk));
    assert.equal(chunks.filter((event) => event.type === "text.delta").map((event) => event.delta).join(""), "Hi from Gemini.");
    assert.equal(chunks.find((event) => event.type === "tool.call").name, "calculator");
    const interaction = [...requests].reverse().find((item) => item.url === "/gemini/interactions");
    const request = JSON.parse(interaction.body);
    assert.equal(request.store, false);
    assert.equal(request.response_format.mime_type, "application/json");
  });
});

test("a revoked Gemini key becomes a provider error without impersonating an Evolv login failure", async () => {
  await withService(async (service) => {
    await service.saveCredentials("gemini", { apiKey: "revoked-gemini-key" });
    await assert.rejects(
      service.models("gemini", { refresh: true }),
      (error) => error.code === "PROVIDER_AUTH_FAILED" && error.status === 424
    );
    const provider = service.list().find((item) => item.id === "gemini");
    assert.equal(provider.configured, true, "the encrypted key remains replaceable");
    assert.equal(provider.status, "error");
    assert.match(provider.statusMessage, /rejected or revoked/i);
  });
});
