import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { toOpenAiResponsesInput } from "../lib/openai-responses.mjs";
import { toLegacyChunk } from "../lib/ai-event-bridge.mjs";
import { toolCall, textDelta, finish, providerState } from "../lib/ai-events.mjs";

// A tool call has to come back to the provider exactly as the provider made it.
//
// The Responses API matches a call to its output by call_id and tracks item
// ids across a turn, and there is no reason to think those are the last fields
// a provider will require echoed. So the adapter keeps the provider's own item
// whole and hands it back, rather than lifting out the fields we happen to know
// about. This test follows one call the whole way — wire, bridge, chat loop,
// database, and back out to the next request — because every previous version
// of this bug lived in one of the joins between those, not inside any of them.
const STEP = { type: "function_call", id: "fc_1", call_id: "fc_1", name: "list_workspace_files", arguments: "{\"path\":\".\"}", status: "completed" };

test("the bridge carries the provider's own step onto the call", () => {
  const event = toolCall({ id: "fc_1", name: "list_workspace_files", arguments: { path: "." }, providerState: { openaiItem: STEP } });
  const chunk = toLegacyChunk(event);

  assert.equal(chunk.message.tool_calls[0].function.name, "list_workspace_files");
  assert.deepEqual(chunk.message.tool_calls[0].providerState, { openaiItem: STEP });
});

test("text, reasoning and finish still arrive in the shape the chat loop reads", () => {
  assert.deepEqual(toLegacyChunk(textDelta("hello")), { message: { content: "hello" } });
  assert.deepEqual(toLegacyChunk(finish("stop")), { done: true, done_reason: "stop" });
});

test("the step survives storage and comes back on the next request", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-state-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  const conversation = database.createConversation("round trip");
  database.addMessage({ conversationId: conversation.id, role: "user", content: "list the files", status: "complete" });
  // Exactly what the chat loop stores after normalize().
  database.addMessage({
    conversationId: conversation.id, role: "assistant", content: "", status: "tool-call",
    metadata: { tool_calls: [{ id: "fc_1", type: "function", providerState: { openaiItem: STEP }, function: { name: "list_workspace_files", arguments: { path: "." } } }] }
  });
  database.addMessage({
    conversationId: conversation.id, role: "tool", toolName: "list_workspace_files",
    toolCallId: "fc_1", content: "README.md", status: "complete"
  });

  const stored = database.getChatMessages(conversation.id, 80);
  const call = stored.find((message) => message.tool_calls)?.tool_calls[0];
  assert.deepEqual(call.providerState, { openaiItem: STEP }, "the database kept it");

  const repaired = sanitizeConversation(stored);
  assert.deepEqual(repaired.find((message) => message.tool_calls).tool_calls[0].providerState, { openaiItem: STEP },
    "the repair pass rewrites calls to give them ids and must not drop it");

  // And the adapter replays the provider's own item rather than rebuilding one
  // from the fields Evolv happens to recognise.
  const input = toOpenAiResponsesInput(repaired);
  const replayed = input.find((item) => item.type === "function_call");
  assert.deepEqual(replayed, STEP, "the provider's item goes back exactly as it arrived");
});

test("a call made elsewhere is still replayed, from what Evolv knows", () => {
  // A conversation that started on Ollama, or that predates Evolv keeping
  // provider state at all, has no item to hand back. The Responses API asks
  // only that a call and its output agree on call_id, so one can be rebuilt
  // from what is stored — unlike a provider that requires a signature it alone
  // could have produced, where rebuilding is impossible and the exchange has to
  // go back as narration instead.
  const input = toOpenAiResponsesInput([
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "search_memory", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "search_memory", content: "nothing" }
  ]);

  const call = input.find((item) => item.type === "function_call");
  const output = input.find((item) => item.type === "function_call_output");
  assert.equal(call.name, "search_memory");
  assert.equal(call.call_id, "c1");
  assert.equal(output.call_id, "c1", "the pair has to agree or the round ends permanently");
  assert.equal(output.output, "nothing");
});

// Reasoning items are the other half of opaque provider state.
//
// A tool call is not the only thing a provider expects back untouched. The
// Responses API tracks reasoning items and their ids across a turn, and the
// adapter reads those from `message.provider_state` — so if the chat loop
// collects only tool calls, a reasoning-heavy turn is replayed missing exactly
// the parts the provider is strictest about.
test("a reasoning step is stored and replayed like a tool call", async (t) => {
  const { createDatabase } = await import("../lib/database.mjs");
  const { mkdtemp: make, rm: remove } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const root = await make(nodePath.join(os.tmpdir(), "evolv-reason-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test" });
  t.after(async () => { database.close(); await remove(root, { recursive: true, force: true }); });

  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] };
  const conversation = database.createConversation("reasoning");
  database.addMessage({ conversationId: conversation.id, role: "user", content: "why", status: "complete" });
  database.addMessage({
    conversationId: conversation.id, role: "assistant", content: "because", status: "complete",
    metadata: { provider_state: [{ provider: "openai", openaiItem: reasoning }] }
  });

  const stored = database.getChatMessages(conversation.id, 80);
  const assistant = stored.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.provider_state, [{ provider: "openai", openaiItem: reasoning }]);

  // And the adapter replays the item rather than flattening it back to text.
  const input = toOpenAiResponsesInput(stored);
  assert.ok(input.some((item) => item.type === "reasoning" && item.id === "rs_1"),
    "the reasoning item goes back with its id");
});

test("the bridge no longer discards provider state", () => {
  // The state object itself is what the adapters read back; each entry is
  // self-describing by the key it carries, so a conversation that moved between
  // a local model and a cloud one stays unambiguous.
  assert.deepEqual(toLegacyChunk(providerState("openai", { openaiItem: { id: "x" } })),
    { providerState: { openaiItem: { id: "x" } } });
});
