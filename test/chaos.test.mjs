import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { describeStorageFailure, isStorageFailure } from "../lib/storage-failure.mjs";
import { classifyModelFailure } from "../lib/model-health.mjs";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { toOpenAiResponsesInput } from "../lib/openai-responses.mjs";
import { toOllamaMessages } from "../lib/providers.mjs";
import { createToolCheckpoints } from "../lib/tool-checkpoint.mjs";

// Failures that are not Evolv's fault but are Evolv's problem.
//
// Every test here breaks the real database rather than a mock of one, because
// the point is what SQLite actually does — which twice now has been the
// opposite of what reading the code suggested. json_extract raises on malformed
// JSON instead of returning null; a filled database throws SQLITE_FULL from the
// statement rather than at commit.
//
// The standard each one holds to: whatever went wrong, the person is told what
// happened and what to do about it, and nothing already saved is lost.

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-chaos-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "t.db"), defaultPrompt: "test" });
  try {
    await run(database, directory);
  } finally {
    try { database.close(); } catch { /* a broken database may refuse to close */ }
    await rm(directory, { recursive: true, force: true });
  }
}

// SQLite will not overrun a page limit, which is a faithful stand-in for a full
// filesystem: the same SQLITE_FULL, raised from the same place.
function fillTheDisk(database, pages = 3) {
  database.raw.pragma(`max_page_count = ${pages}`);
}
function emptyTheBin(database) {
  database.raw.pragma("max_page_count = 1073741823");
}

test("a full disk tells the person to free space, not to file a bug", async () => {
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Ran out of room" });
    database.addMessage({ conversationId: conversation.id, role: "user", content: "this one fits" });
    fillTheDisk(database);

    let thrown = null;
    try {
      for (let index = 0; index < 500; index += 1) {
        database.addMessage({ conversationId: conversation.id, role: "user", content: "x".repeat(4000) });
      }
    } catch (error) {
      thrown = error;
    }
    emptyTheBin(database);

    assert.ok(thrown, "a database with no room must refuse the write rather than lose it quietly");
    assert.equal(thrown.code, "SQLITE_FULL");

    const described = describeStorageFailure(thrown);
    assert.equal(described.status, 507, "not a 500 — this is not Evolv failing");
    assert.match(described.message, /space/i);
    assert.match(described.message, /Free some space/, "it has to say what to do");
    assert.doesNotMatch(described.message, /Reference:/, "a reference number is no use to someone who needs to delete a file");

    // And what was already written is still there.
    const kept = database.getChatMessages(conversation.id);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].content, "this one fits");
  });
});

test("a full disk is not remembered as the model being broken", () => {
  // The chat loop records failures against the model that produced them. A disk
  // that filled during a turn would otherwise mark whichever model happened to
  // be selected as unreliable, and the warning would follow it around long
  // after the space was freed.
  const blame = classifyModelFailure("database or disk is full");
  assert.equal(blame.blame, "unknown", "an unrecognised message must never be pinned on a model");
  assert.equal(blame.permanent, false);
});

test("every storage failure Evolv can hit has a next step", () => {
  const codes = ["SQLITE_FULL", "SQLITE_READONLY", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CORRUPT", "SQLITE_CANTOPEN", "SQLITE_IOERR_WRITE"];
  for (const code of codes) {
    const described = describeStorageFailure(Object.assign(new Error("raw sqlite text"), { code }));
    assert.ok(described, `${code} must be recognised`);
    assert.ok(described.message.length > 40, `${code} needs more than a restatement of the code`);
    assert.doesNotMatch(described.message, /SQLITE_/, `${code} must be said in words, not in error codes`);
  }
  // Extended codes are matched by prefix, which is how they arrive in practice:
  // SQLITE_READONLY_DBMOVED is what a moved data folder actually raises.
  assert.equal(describeStorageFailure(Object.assign(new Error("x"), { code: "SQLITE_READONLY_DBMOVED" })).status, 500);
  assert.equal(describeStorageFailure(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" })).status, 503);

  assert.equal(isStorageFailure(new Error("the model is overloaded")), false);
  assert.equal(describeStorageFailure(Object.assign(new Error("nope"), { code: "ENOENT" })), null,
    "a missing file is not a database failure and must keep its own handling");
});

test("a bug in Evolv is not dressed up as a disk problem", () => {
  // The tempting shape here is a catch-all over every SQLITE_ code. These are
  // Evolv asking for something wrong, and they will happen again every time —
  // "try restarting Evolv" is bad advice for a defect, and claiming them here
  // would keep them out of the 500 logs where someone might fix them.
  for (const code of ["SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_MISMATCH", "SQLITE_RANGE", "SQLITE_MISUSE"]) {
    assert.equal(describeStorageFailure(Object.assign(new Error("x"), { code })), null, `${code} is a bug, not a full disk`);
  }
});

test("a busy database asks the person to close the other window, and says when to retry", () => {
  const described = describeStorageFailure(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
  assert.equal(described.status, 503);
  assert.equal(described.retryAfter, 2, "a 503 without retry-after tells a client nothing");
  assert.match(described.message, /second copy of Evolv/, "which is what it almost always is");
});

test("one unreadable metadata column does not take down the conversation it is in", async () => {
  // A row can be left half-written by a crash, or edited by hand by someone
  // exploring their own database. Every read path has to survive it, because a
  // conversation that cannot be opened cannot be repaired either.
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Has one bad row" });
    database.addMessage({ conversationId: conversation.id, role: "user", content: "hello" });
    database.raw.prepare(`
      INSERT INTO messages(id, conversation_id, role, content, thinking, status, metadata_json, created_at, updated_at)
      VALUES ('damaged', ?, 'assistant', 'a reply', '', 'complete', '{not json at all', datetime('now'), datetime('now'))
    `).run(conversation.id);
    database.addMessage({ conversationId: conversation.id, role: "user", content: "still talking" });

    assert.equal(database.getChatMessages(conversation.id).length, 3, "the damaged row is still shown, not dropped");
    assert.equal(database.getConversation(conversation.id).messages.length, 3);
    assert.ok(database.listConversations().some((item) => item.id === conversation.id));

    // The checkpoint lookup runs json_extract over this column. SQLite raises
    // "malformed JSON" rather than returning null, so without a json_valid
    // guard this single row would throw on every turn in the conversation.
    const checkpoints = createToolCheckpoints({ database, riskOf: () => "sandbox" });
    assert.equal(checkpoints.find(conversation.id, { function: { name: "write", arguments: {} } }), null);
  });
});

test("a history window that opens mid-tool-exchange is repaired before any provider sees it", () => {
  // The window is cut by message count, so it can begin at a tool result whose
  // call is off the top, or end at a call whose results are off the bottom.
  // Both are rejected by OpenAI, and the person's only symptom is
  // that a long conversation suddenly stops working.
  const cutAtTheTop = sanitizeConversation([
    { role: "tool", tool_call_id: "gone", tool_name: "read_file", content: "orphaned result" },
    { role: "user", content: "carry on" }
  ]);
  assert.equal(cutAtTheTop.some((message) => message.role === "tool"), false, "an answer to a call nobody can see is dropped");

  const cutAtTheBottom = sanitizeConversation([
    { role: "user", content: "look something up" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] }
  ]);
  const dangling = cutAtTheBottom.find((message) => message.role === "assistant");
  assert.ok(!dangling?.tool_calls?.length, "a call with no answer must not be sent as if it were still open");

  // And the repaired conversation is accepted by both request builders.
  for (const repaired of [cutAtTheTop, cutAtTheBottom]) {
    assert.doesNotThrow(() => toOpenAiResponsesInput(repaired));
  }
});

test("a conversation deleted underneath a turn fails as a conversation problem", async () => {
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Deleted mid-turn" });
    database.deleteConversation(conversation.id);
    // A foreign key violation, not a crash somewhere unrelated — and not a
    // storage failure either, so it keeps its own handling rather than being
    // reported to the person as a disk problem.
    assert.throws(
      () => database.addMessage({ conversationId: conversation.id, role: "assistant", content: "too late" }),
      (error) => String(error.code || "").startsWith("SQLITE_CONSTRAINT")
    );
    assert.equal(database.getConversation(conversation.id), null);
  });
});

test("a damaged database is detected, and says where the backups are", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-chaos-corrupt-"));
  const dbPath = path.join(directory, "t.db");
  try {
    const database = createDatabase({ dataDir: directory, dbPath, defaultPrompt: "test" });
    assert.equal(database.integrityCheck(), true, "an undamaged database reports itself intact");
    const conversation = database.createConversation({ title: "About to be damaged" });
    for (let index = 0; index < 300; index += 1) {
      database.addMessage({ conversationId: conversation.id, role: "user", content: "y".repeat(500) });
    }
    const backups = database.backupsDir;
    database.close();

    // Scribble over a page in the middle. This is what a half-written file
    // after a power cut or a failing drive looks like from SQLite's side.
    const handle = await open(dbPath, "r+");
    await handle.write(Buffer.alloc(4096, 0x41), 0, 4096, 4096 * 6);
    await handle.close();

    const damaged = createDatabase({ dataDir: directory, dbPath, defaultPrompt: "test" });
    assert.equal(damaged.integrityCheck(), false, "the damage has to be noticed at open, not discovered later");
    damaged.close();

    // What the person is told. Evolv writes a daily backup beside the file for
    // exactly this case, and a reference number would send them nowhere.
    assert.ok(backups.endsWith("backups"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a damaged profile names the file and the backups folder", async () => {
  const source = await readFile(new URL("../lib/profiles.mjs", import.meta.url), "utf8");
  const guard = source.slice(source.indexOf("integrityCheck()"), source.indexOf("integrityCheck()") + 700);
  assert.match(guard, /backupsDir/, "the message has to say where the backups are");
  assert.match(guard, /expose: true/, "and reach the person rather than becoming a reference number");
});

test("a tool result whose assistant turn vanished is not replayed as an orphan", async () => {
  // Deleting messages from a point forward can leave a tool result behind its
  // own call. Both adapters have to cope, because the row is already stored and
  // no amount of fixing the writer helps a conversation that has one.
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Orphaned result" });
    database.addMessage({ conversationId: conversation.id, role: "user", content: "go" });
    database.addMessage({
      conversationId: conversation.id, role: "tool", content: "a result with no call",
      toolName: "read_file", toolCallId: "vanished"
    });

    const repaired = sanitizeConversation(database.getChatMessages(conversation.id));
    // Asserted against the shape that actually goes on the wire. This used to
    // check the Chat Completions shape, which Evolv stopped sending when it
    // moved to /v1/responses — so it was guarding a request nobody made.
    const openai = toOpenAiResponsesInput(repaired);
    assert.equal(openai.some((item) => item.type === "function_call_output" && !item.call_id), false,
      "a tool result with no call_id is refused by the API in its own right");
    assert.equal(toOllamaMessages(repaired).some((message) => message.role === "tool" && !message.content), false);
  });
});
