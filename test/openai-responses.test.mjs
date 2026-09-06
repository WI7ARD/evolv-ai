import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAiResponsesRequest, streamOpenAiResponses, toOpenAiResponsesInput } from "../lib/openai-responses.mjs";

function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("OpenAI Responses request is stateless and uses native function tools", () => {
  const request = buildOpenAiResponsesRequest({
    model: "gpt-5.6",
    think: "high",
    messages: [{ role: "system", content: "Be exact." }, { role: "user", content: "calculate" }],
    tools: [{ type: "function", function: { name: "calculate", description: "Math", parameters: { type: "object" } } }],
    options: { temperature: 1, maxTokens: 2048 }
  });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.instructions, "Be exact.");
  assert.equal(request.reasoning.effort, "high");
  assert.equal(request.max_output_tokens, 2048);
  assert.equal(request.tools[0].name, "calculate");
  assert.equal("temperature" in request, false, "Responses reasoning requests do not inherit Chat Completions sampling knobs");
});

test("OpenAI stream emits canonical deltas and preserves raw output items for stateless replay", async () => {
  let sent;
  const events = [];
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "calculate", arguments: '{"expression":"2+2"}' };
  await streamOpenAiResponses({
    payload: { model: "gpt-5.6", messages: [{ role: "user", content: "2+2" }], options: {} },
    signal: AbortSignal.timeout(5000),
    request: async (route, options) => {
      sent = { route, body: JSON.parse(options.body) };
      return sse([
        { type: "response.reasoning_summary_text.delta", delta: "Checked." },
        { type: "response.output_text.delta", delta: "Using a tool." },
        { type: "response.output_item.added", output_index: 1, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"expression":"2+2"}' },
        { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_1", name: "calculate", arguments: '{"expression":"2+2"}' },
        { type: "response.output_item.done", output_index: 1, item },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 4 } } }
      ]);
    },
    onEvent: (event) => events.push(event)
  });
  assert.equal(sent.route, "/responses");
  assert.equal(sent.body.store, false);
  assert.equal(events.find((event) => event.type === "text.delta").delta, "Using a tool.");
  assert.equal(events.find((event) => event.type === "reasoning.delta").delta, "Checked.");
  const call = events.find((event) => event.type === "tool.call");
  assert.equal(events.filter((event) => event.type === "tool.call").length, 1, "argument completion and item completion cannot duplicate a tool call");
  assert.equal(call.id, "call_1");
  assert.deepEqual(call.arguments, { expression: "2+2" });
  assert.deepEqual(call.providerState.openaiItem, item);

  const replay = toOpenAiResponsesInput([
    { role: "assistant", content: "Using a tool.", provider_state: [{ openaiItem: item }] },
    { role: "tool", tool_call_id: "call_1", content: "4" }
  ]);
  assert.deepEqual(replay[0], item, "provider output item is replayed byte-for-shape instead of reconstructed");
  assert.deepEqual(replay[1], { type: "function_call_output", call_id: "call_1", output: "4" });
});

// The incident this file did not cover.
//
// A user asked the time, OpenAI answered with an `error` step, and Evolv
// reported: "OpenAI sent 4 stream events and Evolv understood none of them […]
// The provider's API has most likely changed shape." It had not. OpenAI had
// said exactly what was wrong, and lib/sse.mjs deleted the sentence — its
// try/catch was written to survive a truncated frame and caught the adapter's
// own throw as well. The real reason was destroyed one frame before anything
// could report it, and the fabricated diagnosis sent the investigation at the
// provider instead of at the parser.
const named = (events) => new Response(
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } }
);

test("a provider-reported failure reaches the caller in the provider's own words", async () => {
  const seen = [];
  await assert.rejects(
    () => streamOpenAiResponses({
      payload: { model: "gpt-4", messages: [{ role: "user", content: "whats the date and time" }] },
      request: async () => named([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.in_progress", response: { id: "resp_1" } },
        { type: "error", error: { code: "model_not_found", message: "The model gpt-4 does not exist or you do not have access to it." } },
        { type: "response.failed", response: { error: { message: "The model gpt-4 does not exist or you do not have access to it." } } }
      ]),
      onEvent: (event) => seen.push(event.type)
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_STREAM_ERROR");
      assert.match(error.message, /does not exist or you do not have access/);
      // The failure this replaces. Reporting an API shape change when the API
      // told us precisely what was wrong is worse than reporting nothing.
      assert.doesNotMatch(error.message, /understood none of them/);
      assert.doesNotMatch(error.message, /changed shape/);
      assert.equal(error.expose, true, "the person has to be allowed to read it");
      return true;
    }
  );
  assert.deepEqual(seen, [], "nothing is emitted from a failed response");
});

test("response.failed alone is enough, and its message is used", async () => {
  // The two arrive together in practice, but either may arrive alone.
  await assert.rejects(
    () => streamOpenAiResponses({
      payload: { model: "gpt-5", messages: [] },
      request: async () => named([
        { type: "response.created", response: { id: "r" } },
        { type: "response.failed", response: { error: { message: "Rate limit reached for gpt-5." } } }
      ]),
      onEvent: () => {}
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_STREAM_ERROR");
      assert.match(error.message, /Rate limit reached/);
      return true;
    }
  );
});

test("one malformed frame is still survived, which is what the guard was for", async () => {
  // The narrowing must not turn a truncated frame into a dead turn. The catch
  // still exists; it just covers JSON.parse and nothing else.
  const warnings = [];
  const body = [
    `data: {"type":"response.output_text.delta","delta":"Hello"}\n\n`,
    `data: {"type":"response.output_text.delta","delta":\n\n`,
    `data: {"type":"response.output_text.delta","delta":" world"}\n\n`,
    `data: {"type":"response.completed","response":{"status":"completed"}}\n\n`
  ].join("");
  const text = [];
  await streamOpenAiResponses({
    payload: { model: "gpt-5", messages: [] },
    request: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    onEvent: (event) => { if (event.type === "text.delta") text.push(event.delta); },
    warn: (message) => warnings.push(message)
  });
  assert.equal(text.join(""), "Hello world", "the good frames still arrive");
});

test("a stream nobody understood is still reported as that", async () => {
  // The witness earns its keep when the events really are unrecognisable. What
  // it must not do is speak for a stream that reported a specific failure.
  await assert.rejects(
    () => streamOpenAiResponses({
      payload: { model: "gpt-5", messages: [] },
      request: async () => named([
        { type: "response.v2.item.finished", item: {} },
        { type: "response.v2.done", response: {} }
      ]),
      onEvent: () => {}
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_STREAM_UNRECOGNIZED");
      assert.match(error.message, /understood none of them/);
      return true;
    }
  );
});

test("thinking turned off omits the parameter rather than saying none", () => {
  // Two ways this sent something OpenAI refuses. `reasoning: { effort: "none" }`
  // is a key present where the request should carry none — a model that does
  // not reason rejects the parameter outright rather than reading it as "do
  // not". And "xhigh" is a level from another vendor's vocabulary.
  const off = buildOpenAiResponsesRequest({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], think: false });
  assert.equal("reasoning" in off, false, "off means the key does not travel");
  assert.equal("reasoning" in buildOpenAiResponsesRequest({ model: "gpt-5", messages: [], think: "none" }), false);
  assert.equal("reasoning" in buildOpenAiResponsesRequest({ model: "gpt-5", messages: [] }), false);

  // Only the levels OpenAI documents are ever sent, and anything unrecognised
  // omits rather than guesses: a request without the parameter works, and one
  // carrying a wrong value does not.
  assert.deepEqual(buildOpenAiResponsesRequest({ model: "gpt-5", messages: [], think: "high" }).reasoning, { effort: "high" });
  assert.deepEqual(buildOpenAiResponsesRequest({ model: "gpt-5", messages: [], think: true }).reasoning, { effort: "medium" });
  assert.deepEqual(buildOpenAiResponsesRequest({ model: "gpt-5", messages: [], think: "xhigh" }).reasoning, { effort: "high" });
  assert.equal("reasoning" in buildOpenAiResponsesRequest({ model: "gpt-5", messages: [], think: "banana" }), false);
});
