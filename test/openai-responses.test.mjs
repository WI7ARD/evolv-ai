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
