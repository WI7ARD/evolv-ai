import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { toOpenAiResponsesInput } from "../lib/openai-responses.mjs";

// OpenAI answers `tool_calls: []` with:
//   Invalid 'messages[6].tool_calls': empty array. Expected an array with
//   minimum length 1, but got an empty array instead
// The index points into the request, so nothing in Evolv could tell you which
// turn of which conversation caused it. An empty array is truthy, which is the
// entire bug: three separate places tested the field for existence instead of
// for length.

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-toolcalls-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "t.db"), defaultPrompt: "test" });
  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("an assistant turn that called no tools emits no function_call item", () => {
  // The Responses API carries a call as its own item rather than as a field on
  // the message, so the failure this guards against changes shape but not
  // nature: an empty tool_calls array must produce no item at all, and a real
  // call must still produce one.
  const input = toOpenAiResponsesInput([
    { role: "assistant", content: "just an answer" },
    { role: "assistant", content: "also just an answer", tool_calls: [] },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] }
  ]);

  const calls = input.filter((item) => item.type === "function_call");
  assert.equal(calls.length, 1, "one real call, and nothing from the empty array");
  assert.equal(calls[0].call_id, "call_1");
  assert.equal(calls[0].name, "read");
  assert.equal(typeof calls[0].arguments, "string", "arguments go as a JSON string");
});

test("history already carrying an empty array is repaired on the way out", async () => {
  // The read-side fix is what matters to anyone who already has one of these
  // stored: their conversation is broken until the history stops replaying it,
  // and no amount of fixing the writer helps a row that is already there.
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Broken by an empty array" });
    database.addMessage({ conversationId: conversation.id, role: "user", content: "hello" });
    database.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "hello back",
      metadata: { tool_calls: [] }
    });

    const [, assistant] = database.getChatMessages(conversation.id);
    assert.equal("tool_calls" in assistant, false);

    // And the whole request, as the provider would see it.
    const request = toOpenAiResponsesInput(database.getChatMessages(conversation.id));
    assert.equal(request.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length === 0), false);
  });
});

test("a stored tool call is still replayed", async () => {
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Real calls survive" });
    const calls = [{ id: "call_1", function: { name: "physics_add_body", arguments: "{}" } }];
    database.addMessage({
      conversationId: conversation.id, role: "assistant", content: "", metadata: { tool_calls: calls }
    });

    const [assistant] = database.getChatMessages(conversation.id);
    assert.deepEqual(assistant.tool_calls, calls, "the fix must not throw away real calls");
  });
});

test("nothing writes an empty array into a message in the first place", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  // The stored metadata and the sent message now agree; they did not before,
  // which is how the empty array reached the database at all.
  // The rule is that tool_calls is only ever written when there are some — not
  // that it is the last key in the object. Pinning what follows it made this
  // fail the moment provider_state was stored beside it, which is a change to
  // the neighbourhood rather than to the rule.
  assert.match(server, /\.\.\.\(normalizedCalls\.length \? \{ tool_calls: normalizedCalls \} : \{\}\)/);
  // Comments removed first: the line that explains this bug necessarily
  // contains the shape it is warning about.
  const code = server.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /tool_calls: \[\]/, "an empty array is never written");
});
