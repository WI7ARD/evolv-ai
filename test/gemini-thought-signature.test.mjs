import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toGeminiContents } from "../lib/providers.mjs";
import { inspectGeminiRequest } from "../lib/provider-contract.mjs";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";

// Gemini refuses a replayed tool call that lost its signature.
//
//   Gemini chat failed (400): Function call is missing a thought_signature in
//   functionCall parts. ... function call default_api:list_workspace_files,
//   position 6.
//
// Gemini's thinking models attach an opaque thoughtSignature to every
// functionCall they emit, and require it back, verbatim, when that call appears
// in history. Evolv parsed the call as name and arguments and dropped the rest,
// so the first round worked and the round that replayed it failed — which is
// why this only ever bit conversations that actually used a tool.
//
// The carrier is providerMeta: anything a provider needs echoed goes there, and
// every other adapter reads only name, arguments and id, so it travels
// harmlessly through a conversation that changes provider.

const CALL = {
  id: "call_1",
  type: "function",
  providerMeta: { thoughtSignature: "Cs4BAdHtim9abc==" },
  function: { name: "list_workspace_files", arguments: { path: "." } }
};

test("a signature Gemini issued comes back on the call it belongs to", () => {
  const [content] = toGeminiContents([{ role: "assistant", content: "", tool_calls: [CALL] }]);
  const part = content.parts.find((item) => item.functionCall);

  assert.equal(part.functionCall.name, "list_workspace_files");
  assert.equal(part.thoughtSignature, "Cs4BAdHtim9abc==", "the signature travels beside the call, not inside it");
  assert.deepEqual(inspectGeminiRequest([content]), []);
});

test("a conversation that never had signatures is left alone", () => {
  // Calls made on OpenAI or Ollama and continued on Gemini carry no signature,
  // and Gemini does not expect one for a call it did not make. Flagging those
  // would warn on every cross-provider conversation — the fuzzer caught exactly
  // that when the rule was first written as "every call must be signed".
  const [content] = toGeminiContents([{
    role: "assistant", content: "",
    tool_calls: [{ id: "call_2", type: "function", function: { name: "search_memory", arguments: {} } }]
  }]);
  const part = content.parts.find((item) => item.functionCall);

  assert.equal("thoughtSignature" in part, false, "nothing is invented when there is no signature");
  assert.deepEqual(inspectGeminiRequest([content]), []);
});

test("a signature lost from one call among several is named", () => {
  // This is the shape of the actual fault: Evolv held signatures and dropped
  // one. The raw API error says only "position 6", which is not enough to act
  // on.
  const [content] = toGeminiContents([{
    role: "assistant", content: "",
    tool_calls: [CALL, { id: "call_3", type: "function", function: { name: "search_memory", arguments: {} } }]
  }]);

  assert.deepEqual(inspectGeminiRequest([content]), [
    "content 0: functionCall search_memory lost its thoughtSignature while others kept theirs"
  ]);
});

test("the signature survives the repair pass that rewrites tool calls", () => {
  // Hygiene assigns ids to calls that lack them, rebuilding each call as it
  // goes. Rebuilding by hand rather than spreading would drop the signature at
  // the last step before sending.
  const repaired = sanitizeConversation([
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [{ ...CALL, id: undefined }] },
    { role: "tool", tool_name: "list_workspace_files", content: "README.md" }
  ]);
  const call = repaired.find((message) => message.tool_calls)?.tool_calls[0];

  assert.ok(call.id, "hygiene gave it an id");
  assert.deepEqual(call.providerMeta, { thoughtSignature: "Cs4BAdHtim9abc==" });
});

test("the chat loop does not discard provider metadata when it normalises", async () => {
  // normalize() rebuilds every call as {id, type, function}, and anything not
  // named there is gone. That is where the signature used to die, between the
  // round that produced the call and the round that replayed it.
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const start = server.indexOf("const normalize = (call) =>");
  const body = server.slice(start, start + 600);
  assert.match(body, /providerMeta/, "normalize must carry providerMeta or the signature is lost on the next round");
});

test("other providers are untroubled by metadata they do not use", async () => {
  const { normalizeMessagesOpenAi, toAnthropicMessages, toOllamaMessages } = await import("../lib/providers.mjs");
  const conversation = [
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [CALL] },
    { role: "tool", tool_call_id: "call_1", tool_name: "list_workspace_files", content: "README.md" }
  ];

  // Each adapter reads what it needs and ignores the rest — a conversation that
  // started on Gemini has to remain sendable everywhere else.
  const openai = normalizeMessagesOpenAi(conversation);
  assert.equal(openai.find((m) => m.tool_calls)?.tool_calls[0].function.name, "list_workspace_files");

  const anthropic = toAnthropicMessages(conversation);
  assert.ok(anthropic.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === "call_1")));

  const ollama = toOllamaMessages(conversation);
  assert.equal(typeof ollama.find((m) => m.tool_calls)?.tool_calls[0].function.arguments, "object");
});
