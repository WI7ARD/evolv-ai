import test from "node:test";
import assert from "node:assert/strict";
import { buildGeminiInteractionRequest, streamGeminiInteraction, toGeminiInteractionInput } from "../lib/gemini-interactions.mjs";

function namedSse(events) {
  return new Response(events.map(({ name, data }) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("Gemini Interactions request is stateless and uses provider-native tools", () => {
  const request = buildGeminiInteractionRequest({
    model: "gemini-3.6-flash",
    think: "low",
    messages: [{ role: "system", content: "Be exact." }, { role: "user", content: "calculate" }],
    tools: [{ type: "function", function: { name: "calculate", description: "Math", parameters: { type: "object" } } }],
    options: { maxTokens: 1024, temperature: 0.7 }
  });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.system_instruction, "Be exact.");
  assert.equal(request.generation_config.thinking_level, "low");
  assert.equal(request.generation_config.thinking_summaries, "auto");
  assert.equal("temperature" in request.generation_config, false, "Interactions does not inherit unsupported legacy sampling fields");
  assert.equal(request.tools[0].name, "calculate");
});

test("Gemini Interactions stream preserves function-call steps for exact stateless replay", async () => {
  const events = [];
  let route;
  const step = { type: "function_call", id: "call_1", name: "calculate", arguments: { expression: "2+2" } };
  await streamGeminiInteraction({
    payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "2+2" }], options: {} },
    signal: AbortSignal.timeout(5000),
    request: async (requestedRoute) => {
      route = requestedRoute;
      return namedSse([
        { name: "step.start", data: { index: 0, step: { type: "model_output" } } },
        { name: "step.delta", data: { index: 0, delta: { type: "text", text: "Checking." } } },
        { name: "step.stop", data: { index: 0, status: "done" } },
        { name: "step.start", data: { index: 1, step: { type: "function_call", id: "call_1", name: "calculate" } } },
        { name: "step.delta", data: { index: 1, delta: { type: "arguments", partial_arguments: '{"expression":"2+2"}' } } },
        { name: "step.stop", data: { index: 1, status: "waiting" } },
        { name: "interaction.completed", data: { interaction: { status: "completed", usage: { input_tokens: 8, output_tokens: 3 } } } }
      ]);
    },
    onEvent: (event) => events.push(event)
  });
  assert.equal(route, "/interactions");
  assert.equal(events.find((event) => event.type === "text.delta").delta, "Checking.");
  assert.deepEqual(events.find((event) => event.type === "provider.state").state.geminiStep,
    { type: "model_output", content: [{ type: "text", text: "Checking." }] });
  const call = events.find((event) => event.type === "tool.call");
  assert.equal(call.id, "call_1");
  assert.deepEqual(call.arguments, { expression: "2+2" });
  assert.deepEqual(call.providerState.geminiStep, step);

  const replay = toGeminiInteractionInput([
    { role: "assistant", provider_state: [{ geminiStep: step }] },
    { role: "tool", tool_name: "calculate", tool_call_id: "call_1", content: "4" }
  ]);
  assert.deepEqual(replay[0], step);
  assert.equal(replay[1].type, "function_result");
  assert.equal(replay[1].call_id, "call_1");
  assert.equal(replay[1].result[0].text, "4");
});
