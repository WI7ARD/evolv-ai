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

// The 400 a user actually hit, on a build that had every other part of this
// work in it:
//
//   Function call is missing a thought_signature in functionCall parts. This is
//   required for tools to work correctly. Additional data, function call
//   default_api:list_obsidian_notes, position 4.
//
// Position 4 is history, not the current turn. Evolv now stores the provider's
// own step for every call it makes, but nothing can retrofit one onto a call
// made before that — or onto a call made by a different provider in the same
// conversation. Those were being replayed as a fabricated function_call with no
// signature, which is precisely what Gemini refuses.
test("a tool call with no provider step is never replayed as a function call", () => {
  const messages = [
    { role: "user", content: "what notes do I have?" },
    // Written before Evolv kept provider state: tool_calls, no provider_state.
    { role: "assistant", content: "", tool_calls: [{ id: "call_a", function: { name: "list_obsidian_notes", arguments: { limit: 20 } } }] },
    { role: "tool", tool_call_id: "call_a", tool_name: "list_obsidian_notes", content: "meeting.md\nideas.md" },
    { role: "assistant", content: "You have two notes." },
    { role: "user", content: "open the second one" }
  ];

  const input = toGeminiInteractionInput(messages);
  assert.equal(input.some((step) => step.type === "function_call"), false,
    "an unsigned call must not be sent; this is the 400");
  assert.equal(input.some((step) => step.type === "function_result"), false,
    "and its result must not be sent as an orphan answering nothing");

  // The work is not thrown away either — the model can still see what it did.
  const narrated = input.filter((step) => step.type === "user_input")
    .flatMap((step) => step.content).map((part) => part.text).join("\n");
  assert.match(narrated, /list_obsidian_notes/);
  assert.match(narrated, /meeting\.md/, "the result the model already has is still available to it");
});

test("a call that does carry the provider's step is replayed exactly", () => {
  const signed = {
    type: "function_call", id: "fc_1", call_id: "call_b", name: "read_obsidian_note",
    arguments: { path: "ideas.md" }, thought_signature: "sig-from-gemini"
  };
  const messages = [
    { role: "user", content: "read it" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_b", providerState: { geminiStep: signed }, function: { name: "read_obsidian_note", arguments: { path: "ideas.md" } } }] },
    { role: "tool", tool_call_id: "call_b", tool_name: "read_obsidian_note", content: "the note body" }
  ];

  const input = toGeminiInteractionInput(messages);
  const call = input.find((step) => step.type === "function_call");
  assert.deepEqual(call, signed, "the provider's own step goes back byte for byte, signature included");
  const result = input.find((step) => step.type === "function_result");
  assert.equal(result.call_id, "call_b", "and its result is still a real function_result");
});

test("a conversation that changed providers mid-way keeps both halves", () => {
  // Started on OpenAI, switched to Gemini. The OpenAI call has an openaiItem,
  // not a geminiStep, so it cannot be replayed as a Gemini call — but the model
  // still needs to know it happened.
  const messages = [
    { role: "user", content: "search" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_o", providerState: { openaiItem: { id: "fc_x" } }, function: { name: "search_memory", arguments: {} } }] },
    { role: "tool", tool_call_id: "call_o", tool_name: "search_memory", content: "three matches" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_g", providerState: { geminiStep: { type: "function_call", call_id: "call_g", name: "read_file", arguments: {}, thought_signature: "s" } }, function: { name: "read_file", arguments: {} } }] },
    { role: "tool", tool_call_id: "call_g", tool_name: "read_file", content: "file body" }
  ];

  const input = toGeminiInteractionInput(messages);
  const calls = input.filter((step) => step.type === "function_call");
  assert.equal(calls.length, 1, "only the Gemini call is replayable as a call");
  assert.equal(calls[0].call_id, "call_g");
  const results = input.filter((step) => step.type === "function_result");
  assert.equal(results.length, 1, "and only its result is a function_result");
  assert.equal(results[0].call_id, "call_g");
  const narrated = input.filter((step) => step.type === "user_input").flatMap((step) => step.content).map((part) => part.text).join("\n");
  assert.match(narrated, /search_memory/);
  assert.match(narrated, /three matches/);
});
