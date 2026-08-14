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
      // Stands in for a reasoning model: it accepts only the default sampling
      // parameters and says so in OpenAI's exact wording.
      const sent = JSON.parse(body || "{}");
      if (sent.model === "openai/gpt-5.5" && "temperature" in sent) {
        return json(400, {
          error: {
            message: "Unsupported value: 'temperature' does not support 0.9 with this model. Only the default (1) value is supported.",
            param: "temperature",
            type: "invalid_request_error"
          }
        });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Thinking… " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Routed " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "reply." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0, id: "call_1", function: { name: "calculator", arguments: "{\"expression\":\"2+2\"}" }
      }] } }] })}\n\n`);
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
    if (req.url.startsWith("/gemini/models/") && req.url.includes(":streamGenerateContent") && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      sse({ candidates: [{ content: { parts: [{ text: "Hi from " }] } }] });
      sse({ candidates: [{ content: { parts: [{ text: "Gemini." }] } }] });
      sse({ candidates: [{ content: { parts: [{ functionCall: { name: "calculator", args: { expression: "2+2" } } }] } }] });
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
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk.message));
    assert.equal(chunks.map((message) => message.content || "").join(""), "Hi from Claude.");
    assert.ok(chunks.filter((message) => message.content).length >= 2, "text arrives as incremental deltas");
    assert.equal(chunks.map((message) => message.thinking || "").join(""), "Let me reason.");
    const toolCall = chunks.find((message) => message.tool_calls)?.tool_calls[0];
    assert.equal(toolCall.function.name, "calculator");
    assert.deepEqual(toolCall.function.arguments, { expression: "2+2" }, "tool input reassembled from input_json_delta");

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
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk.message));
    assert.equal(chunks.map((message) => message.content || "").join(""), "Routed reply.");
    assert.equal(chunks.map((message) => message.thinking || "").join(""), "Thinking… ");
    const toolCall = chunks.find((message) => message.tool_calls)?.tool_calls[0];
    assert.equal(toolCall.function.name, "calculator");
    assert.equal(toolCall.function.arguments, "{\"expression\":\"2+2\"}");
  });
});

test("Gemini filters non-chat models and bridges generateContent responses", async () => {
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
      options: { temperature: 0 }
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk.message));
    assert.equal(chunks.map((message) => message.content || "").join(""), "Hi from Gemini.");
    assert.ok(chunks.filter((message) => message.content).length >= 2, "text arrives as incremental deltas");
    const toolCall = chunks.find((message) => message.tool_calls)?.tool_calls[0];
    assert.equal(toolCall.function.name, "calculator");
    assert.deepEqual(toolCall.function.arguments, { expression: "2+2" });

    const chatRequest = lastRequest((url) => url.includes(":streamGenerateContent"));
    assert.equal(chatRequest.url, "/gemini/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    assert.equal(JSON.parse(chatRequest.body).generationConfig.maxOutputTokens, 4096, "default max tokens applied");
  });
});

test("a repaired conversation reaches every provider in a shape it accepts", async () => {
  // The conversation Evolv's 80-message window can produce after a truncation:
  // an orphaned tool result at the top, a call whose answer never arrived, and
  // an assistant turn with nothing in it. Sent as-is, each provider refuses it
  // with a different sentence naming an index into the request.
  const { sanitizeConversation } = await import("../lib/message-hygiene.mjs");
  const damaged = [
    { role: "system", content: "Be brief." },
    { role: "tool", tool_call_id: "call_above_the_window", content: "orphaned output" },
    { role: "assistant", content: "" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "Working on it.", tool_calls: [{ id: "call_unanswered", function: { name: "read", arguments: "{}" } }] }
  ];
  const messages = sanitizeConversation(damaged);

  await withService(async (service) => {
    await service.saveCredentials("anthropic", { apiKey: "sk-ant-test-key" });
    await service.saveCredentials("gemini", { apiKey: "gemini-test-key" });

    for (const [providerId, model, url] of [
      ["anthropic", "claude-4-sonnet", "/anthropic/messages"],
      ["gemini", "gemini-2.5-flash", null]
    ]) {
      await service.streamRound(providerId, {
        model, messages, options: { temperature: 0, maxTokens: 1024 }
      }, AbortSignal.timeout(5000), () => {});

      const request = lastRequest((item) => (url ? item === url : item.includes("streamGenerateContent")));
      const body = JSON.parse(request.body);
      const turns = body.messages || body.contents;

      assert.ok(turns.length, `${providerId} received a conversation`);
      // The two shapes every provider rejects.
      assert.equal(turns.some((turn) => !(turn.content || turn.parts)?.length), false,
        `${providerId} was sent a message with no content`);
      assert.equal(JSON.stringify(turns).includes("call_above_the_window"), false,
        `${providerId} was sent a result for a call it never saw`);
      assert.equal(turns[0].role, "user", `${providerId} needs the conversation to start with the user`);
    }
  });
});

test("a model that refuses a sampling parameter is asked again without it", async () => {
  // Reasoning models accept only the default temperature. Evolv keeps no list
  // of which models those are, because such a list is stale the day a model
  // ships; it drops whatever the provider names and asks once more.
  await withService(async (service) => {
    await service.saveCredentials("openrouter", { apiKey: "sk-or-test-key" });
    const chunks = [];
    await service.streamRound("openrouter", {
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.9 }
    }, AbortSignal.timeout(5000), (chunk) => chunks.push(chunk.message));

    // The reply arrives rather than the person seeing a 400 about a number
    // they never chose.
    assert.equal(chunks.map((message) => message.content || "").join(""), "Routed reply.");

    const sent = requests.filter((item) => item.url === "/openrouter/chat/completions").slice(-2).map((item) => JSON.parse(item.body));
    assert.equal(sent[0].temperature, 0.9, "the first attempt asked for what was configured");
    assert.equal("temperature" in sent[1], false, "the retry dropped exactly the refused parameter");
    assert.equal(sent[1].model, "openai/gpt-5.5", "and changed nothing else");
    assert.deepEqual(sent[1].messages, sent[0].messages);
  });
});

test("only sampling parameters are ever dropped", async () => {
  const { refusedParameter } = await import("../lib/providers.mjs");
  const as400 = (payload) => new Response(JSON.stringify(payload), { status: 400 });

  assert.equal(await refusedParameter(as400({ error: { param: "temperature", message: "Unsupported value" } })), "temperature");
  assert.equal(await refusedParameter(as400({ error: { message: "Unsupported value: 'top_p' is not supported" } })), "top_p");
  // A complaint about the conversation itself is a different problem, and
  // retrying without it would send a request that means something else.
  assert.equal(await refusedParameter(as400({ error: { param: "messages", message: "Invalid 'messages[6]'" } })), "");
  assert.equal(await refusedParameter(as400({ error: { param: "model", message: "no longer available" } })), "");
  assert.equal(await refusedParameter(as400({})), "");
});

test("Gemini is sent no systemInstruction rather than an empty one", async () => {
  // Titles and memory extraction are asked without any system message. An
  // instruction whose only part is an empty string is a 400.
  await withService(async (service) => {
    await service.saveCredentials("gemini", { apiKey: "gemini-test-key" });
    await service.streamRound("gemini", {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "name this chat" }],
      options: { temperature: 0, maxTokens: 64 }
    }, AbortSignal.timeout(5000), () => {});

    const body = JSON.parse(lastRequest((url) => url.includes("streamGenerateContent")).body);
    assert.equal("systemInstruction" in body, false);
  });
});

test("Anthropic reasoning is decided by generation, not by a list that goes stale", async () => {
  // The pattern this replaces listed the generations it knew about, so every
  // new Claude arrived without reasoning support and looked worse than it is.
  const { conservativeCapabilities } = await import("../lib/providers.mjs");
  const thinks = (name) => conservativeCapabilities("anthropic", name).includes("thinking");

  // Both orders Anthropic uses, and the generation extended thinking arrived in.
  assert.equal(thinks("claude-3-5-sonnet"), false);
  assert.equal(thinks("claude-3-7-sonnet-20250219"), true);
  for (const name of ["claude-4-sonnet", "claude-opus-4-20250514", "claude-sonnet-4-5",
    "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
    assert.equal(thinks(name), true, name);
  }
  assert.equal(thinks("claude-2.1"), false);
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
