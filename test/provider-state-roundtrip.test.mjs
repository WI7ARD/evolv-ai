import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { toGeminiInteractionInput } from "../lib/gemini-interactions.mjs";
import { toLegacyChunk } from "../lib/ai-event-bridge.mjs";
import { toolCall, textDelta, finish } from "../lib/ai-events.mjs";

// A tool call has to come back to the provider exactly as the provider made it.
//
// Gemini refuses a replayed call whose signature is missing, and there is no
// reason to think it is the last field a provider will require echoed. So the
// adapters keep the provider's own step whole and hand it back, rather than
// lifting out the fields we happen to know about. This test follows one call
// the whole way — wire, bridge, chat loop, database, and back out to the next
// request — because every previous version of this bug lived in one of the
// joins between those, not inside any of them.

const STEP = { type: "function_call", id: "fc_1", call_id: "fc_1", name: "list_workspace_files", arguments: { path: "." }, signature: "Cs4BAdHtim9abc==" };

test("the bridge carries the provider's own step onto the call", () => {
  const event = toolCall({ id: "fc_1", name: "list_workspace_files", arguments: { path: "." }, providerState: { geminiStep: STEP } });
  const chunk = toLegacyChunk(event);

  assert.equal(chunk.message.tool_calls[0].function.name, "list_workspace_files");
  assert.deepEqual(chunk.message.tool_calls[0].providerState, { geminiStep: STEP });
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
    metadata: { tool_calls: [{ id: "fc_1", type: "function", providerState: { geminiStep: STEP }, function: { name: "list_workspace_files", arguments: { path: "." } } }] }
  });
  database.addMessage({
    conversationId: conversation.id, role: "tool", toolName: "list_workspace_files",
    toolCallId: "fc_1", content: "README.md", status: "complete"
  });

  const stored = database.getChatMessages(conversation.id, 80);
  const call = stored.find((message) => message.tool_calls)?.tool_calls[0];
  assert.deepEqual(call.providerState, { geminiStep: STEP }, "the database kept it");

  const repaired = sanitizeConversation(stored);
  assert.deepEqual(repaired.find((message) => message.tool_calls).tool_calls[0].providerState, { geminiStep: STEP },
    "the repair pass rewrites calls to give them ids and must not drop it");

  // And the adapter replays the provider's step rather than rebuilding one.
  const input = toGeminiInteractionInput(repaired);
  const replayed = input.find((step) => step.type === "function_call");
  assert.deepEqual(replayed, STEP, "the step goes back exactly as it arrived, signature included");
});

test("a call made elsewhere is rebuilt rather than dropped", () => {
  // A conversation that started on OpenAI or Ollama has no Gemini step to
  // replay. It still has to be sendable — reconstructed from name and
  // arguments, without inventing a signature.
  const input = toGeminiInteractionInput([
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "search_memory", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "search_memory", content: "nothing" }
  ]);
  const call = input.find((step) => step.type === "function_call");

  assert.equal(call.name, "search_memory");
  assert.deepEqual(call.arguments, {}, "a JSON string from another provider becomes an object");
  assert.equal("signature" in call, false, "nothing is invented");
});
