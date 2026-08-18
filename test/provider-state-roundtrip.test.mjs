import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { toGeminiInteractionInput } from "../lib/gemini-interactions.mjs";
import { toLegacyChunk } from "../lib/ai-event-bridge.mjs";
import { toolCall, textDelta, finish, providerState } from "../lib/ai-events.mjs";

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

test("a call made elsewhere is narrated, not rebuilt as a call", () => {
  // This test previously asserted the opposite — that a call with no Gemini
  // step is "reconstructed from name and arguments, without inventing a
  // signature" — and that expectation was wrong. Gemini rejects the request
  // outright:
  //
  //   Function call is missing a thought_signature in functionCall parts.
  //
  // "Without inventing a signature" is not a safe middle ground, because a
  // functionCall part with no signature is not a weaker call, it is an invalid
  // one. A conversation that started on OpenAI or Ollama, or that predates
  // Evolv keeping provider state at all, has nothing to replay — so the
  // exchange goes back as context rather than as a call.
  const input = toGeminiInteractionInput([
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "search_memory", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "search_memory", content: "nothing" }
  ]);

  assert.equal(input.some((step) => step.type === "function_call"), false);
  assert.equal(input.some((step) => step.type === "function_result"), false);
  const narrated = input.filter((step) => step.type === "user_input")
    .flatMap((step) => step.content).map((part) => part.text).join("\n");
  assert.match(narrated, /search_memory/, "the model is still told what it called");
  assert.match(narrated, /nothing/, "and what came back");
});

// Reasoning items are the other half of opaque provider state.
//
// A tool call is not the only thing a provider expects back untouched. Gemini's
// thinking steps carry their own signatures, and OpenAI's Responses API tracks
// item ids across a turn. Both adapters read those from `message.provider_state`
// — so if the chat loop collects only tool calls, a reasoning-heavy turn is
// replayed missing exactly the parts the provider is strictest about.
test("a reasoning step is stored and replayed like a tool call", async (t) => {
  const { createDatabase } = await import("../lib/database.mjs");
  const { mkdtemp: make, rm: remove } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const root = await make(nodePath.join(os.tmpdir(), "evolv-reason-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test" });
  t.after(async () => { database.close(); await remove(root, { recursive: true, force: true }); });

  const reasoning = { type: "reasoning", id: "r_1", summary: [{ type: "text", text: "thinking" }], signature: "sig-reasoning" };
  const conversation = database.createConversation("reasoning");
  database.addMessage({ conversationId: conversation.id, role: "user", content: "why", status: "complete" });
  database.addMessage({
    conversationId: conversation.id, role: "assistant", content: "because", status: "complete",
    metadata: { provider_state: [{ provider: "gemini", geminiStep: reasoning }] }
  });

  const stored = database.getChatMessages(conversation.id, 80);
  const assistant = stored.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.provider_state, [{ provider: "gemini", geminiStep: reasoning }]);

  // And the adapter replays the step rather than flattening it back to text.
  const input = toGeminiInteractionInput(stored);
  assert.ok(input.some((step) => step.type === "reasoning" && step.signature === "sig-reasoning"),
    "the reasoning step goes back with its signature");
});

test("the bridge no longer discards provider state", () => {
  // The state object itself is what the adapters read back; each entry is
  // self-describing by the key it carries — openaiItem or geminiStep — so a
  // conversation that changed provider stays unambiguous.
  assert.deepEqual(toLegacyChunk(providerState("openai", { openaiItem: { id: "x" } })),
    { providerState: { openaiItem: { id: "x" } } });
});
