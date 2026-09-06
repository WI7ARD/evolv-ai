import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";

const call = (id, name = "read_file") => ({ id, function: { name, arguments: "{}" } });

test("a window that opens mid-tool-exchange drops the orphaned result", () => {
  // The 80-message window is cut by count, not by meaning. This is what it
  // looks like when the cut lands between a call and its answer: every provider
  // refuses the result, and the conversation fails from that message onwards.
  const sanitized = sanitizeConversation([
    { role: "tool", tool_call_id: "call_gone", content: "output of a call above the window" },
    { role: "user", content: "carry on" },
    { role: "assistant", content: "certainly" }
  ]);

  assert.deepEqual(sanitized.map((message) => message.role), ["user", "assistant"]);
  assert.equal(sanitized.some((message) => message.role === "tool"), false);
});

test("tool output is never rewritten as something the model said", () => {
  // Dropping the orphan is right; keeping its text as a normal message would
  // put raw tool output into the conversation in the model's voice.
  const sanitized = sanitizeConversation([
    { role: "tool", tool_call_id: "call_gone", content: "SECRET-TOOL-OUTPUT" },
    { role: "user", content: "hello" }
  ]);

  assert.equal(JSON.stringify(sanitized).includes("SECRET-TOOL-OUTPUT"), false);
});

test("a call whose answer never arrived loses the call and keeps the words", () => {
  // An interrupted generation leaves this behind. OpenAI requires every tool
  // call to be answered; the sentence the model managed is still worth sending.
  const sanitized = sanitizeConversation([
    { role: "user", content: "read the file" },
    { role: "assistant", content: "Looking now.", tool_calls: [call("call_1")] }
  ]);

  assert.equal(sanitized.length, 2);
  assert.equal("tool_calls" in sanitized[1], false);
  assert.equal(sanitized[1].content, "Looking now.");
});

test("an answered call survives untouched, and a half-answered one keeps the answered half", () => {
  const sanitized = sanitizeConversation([
    { role: "user", content: "read both" },
    { role: "assistant", content: "", tool_calls: [call("call_1"), call("call_2")] },
    { role: "tool", tool_call_id: "call_1", content: "first result" }
  ]);

  assert.deepEqual(sanitized.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.deepEqual(sanitized[1].tool_calls.map((item) => item.id), ["call_1"]);
});

test("a message with nothing in it is dropped rather than sent as empty content", () => {
  // Anthropic builds content: [] and Gemini parts: [] from this, and both
  // refuse the request.
  const sanitized = sanitizeConversation([
    { role: "user", content: "hello" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "   ", tool_calls: [] },
    { role: "assistant", content: "a real answer" }
  ]);

  assert.deepEqual(sanitized.map((message) => message.content), ["hello", "a real answer"]);
});

test("an empty tool_calls array never survives", () => {
  const [assistant] = sanitizeConversation([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [] }
  ]).filter((message) => message.role === "assistant");

  assert.equal("tool_calls" in assistant, false);
});

test("a conversation always starts with the user, whatever the window cut", () => {
  // Anthropic requires it, and an assistant reply at the top is a truncation
  // artefact rather than a turn anyone took.
  const sanitized = sanitizeConversation([
    { role: "assistant", content: "the tail of an older answer" },
    { role: "user", content: "the first thing in this window" },
    { role: "assistant", content: "fine" }
  ]);

  assert.equal(sanitized[0].role, "user");
  assert.equal(sanitized[0].content, "the first thing in this window");
});

test("system messages are left where they are", () => {
  const sanitized = sanitizeConversation([
    { role: "system", content: "you are Evolv" },
    { role: "assistant", content: "orphaned reply" },
    { role: "user", content: "hello" }
  ]);

  assert.equal(sanitized[0].role, "system");
  assert.equal(sanitized[1].role, "user");
});

test("a window with no user message at all sends no conversation", () => {
  // Nothing here is answerable, and sending an assistant-only conversation is a
  // 400 on two providers.
  assert.deepEqual(sanitizeConversation([{ role: "assistant", content: "alone" }]), []);
  assert.deepEqual(sanitizeConversation([]), []);
});

test("an ordinary conversation is passed through unchanged", () => {
  // The repair must be invisible when there is nothing to repair.
  const conversation = [
    { role: "system", content: "you are Evolv" },
    { role: "user", content: "add a box" },
    { role: "assistant", content: "", tool_calls: [call("call_1", "physics_add_body")] },
    { role: "tool", tool_call_id: "call_1", tool_name: "physics_add_body", content: "{\"id\":\"b1\"}" },
    { role: "assistant", content: "Added a box." },
    { role: "user", content: "now drop it" }
  ];

  assert.deepEqual(sanitizeConversation(conversation), conversation);
});

test("a conversation held with Ollama can be continued on a cloud model", () => {
  // Ollama issues no call ids. OpenAI requires one on both sides and Anthropic
  // pairs tool_result to tool_use by id, so rotating from a local model to a
  // cloud one failed on the first reply. The ids are invented and paired here.
  const [, assistant, result] = sanitizeConversation([
    { role: "user", content: "read it" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_name: "read_file", content: "contents" }
  ]);

  assert.ok(assistant.tool_calls[0].id, "the call gained an id");
  assert.equal(result.tool_call_id, assistant.tool_calls[0].id, "and its answer carries the same one");
});

test("two id-less calls are paired with the right answers, by name", () => {
  const [, assistant, first, second] = sanitizeConversation([
    { role: "user", content: "do both" },
    { role: "assistant", content: "", tool_calls: [
      { function: { name: "read_file", arguments: "{}" } },
      { function: { name: "list_dir", arguments: "{}" } }
    ] },
    // Deliberately out of order: pairing by position alone would cross them.
    { role: "tool", tool_name: "list_dir", content: "a listing" },
    { role: "tool", tool_name: "read_file", content: "file contents" }
  ]);

  const byId = new Map(assistant.tool_calls.map((call) => [call.id, call.function.name]));
  assert.equal(byId.get(first.tool_call_id), "list_dir");
  assert.equal(byId.get(second.tool_call_id), "read_file");
  assert.notEqual(first.tool_call_id, second.tool_call_id);
});

test("a tool result nothing ever asked for is dropped even without an id", () => {
  // After pairing, a result still carrying no id answers no call in the window.
  const sanitized = sanitizeConversation([
    { role: "user", content: "hello" },
    { role: "tool", tool_name: "read_file", content: "output with no call above it" }
  ]);

  assert.deepEqual(sanitized.map((message) => message.role), ["user"]);
});
