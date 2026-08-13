import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { normalizeMessagesOpenAi } from "../lib/providers.mjs";

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

test("an assistant turn that called no tools sends no tool_calls field", () => {
  const [none, empty, real] = normalizeMessagesOpenAi([
    { role: "assistant", content: "just an answer" },
    { role: "assistant", content: "also just an answer", tool_calls: [] },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] }
  ]);

  assert.equal("tool_calls" in none, false);
  assert.equal("tool_calls" in empty, false, "an empty array must be dropped, not passed through");
  assert.equal(real.tool_calls.length, 1, "and a real call still goes");
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
    const request = normalizeMessagesOpenAi(database.getChatMessages(conversation.id));
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
  assert.match(server, /\.\.\.\(normalizedCalls\.length \? \{ tool_calls: normalizedCalls \} : \{\}\)\s*\n\s*\}/);
});
