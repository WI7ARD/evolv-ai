import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { checkpointSignature, createToolCheckpoints, isEffectfulRisk, checkpointNotice } from "../lib/tool-checkpoint.mjs";

// The bug this exists for: a turn that suspends for an approval, or dies when
// the window closes, is resumed later with new call ids for the same work. The
// in-memory dedupe map went with the request, so the second attempt re-executed
// everything — including the write the person had just approved.

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-checkpoint-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "t.db"), defaultPrompt: "test" });
  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const RISKS = {
  read_file: "read",
  sandbox_write: "sandbox",
  propose_edit: "approval-write"
};
const riskOf = (name) => RISKS[name] || "read";

const call = (name, args) => ({ id: `call_${Math.random().toString(16).slice(2)}`, function: { name, arguments: args } });

test("only tools whose second run costs something are checkpointed", () => {
  assert.equal(isEffectfulRisk("read"), false, "a read of a file that may have changed must run again");
  assert.equal(isEffectfulRisk("network-read"), false);
  assert.equal(isEffectfulRisk("sandbox"), true);
  assert.equal(isEffectfulRisk("approval-write"), true);
  assert.equal(isEffectfulRisk("destructive"), true);
  assert.equal(isEffectfulRisk(""), false, "an unknown class is not assumed to have effects");
});

test("the signature ignores call id and key order but not the conversation", () => {
  const a = checkpointSignature("conv-1", call("propose_edit", { path: "a.md", body: "x" }));
  const b = checkpointSignature("conv-1", call("propose_edit", { body: "x", path: "a.md" }));
  const c = checkpointSignature("conv-2", call("propose_edit", { path: "a.md", body: "x" }));
  assert.equal(a, b, "the same request with keys in a different order is the same request");
  assert.notEqual(a, c, "a checkpoint must never cross into another conversation");
});

test("stringified arguments and object arguments agree", () => {
  // Providers differ: one sends arguments as JSON text, another as an object.
  // A checkpoint that could not see through that would miss every replay.
  const asObject = checkpointSignature("c", call("sandbox_write", { name: "x", value: 2 }));
  const asString = checkpointSignature("c", call("sandbox_write", '{"value":2,"name":"x"}'));
  assert.equal(asObject, asString);
});

test("an approved write is not proposed a second time when the turn resumes", async () => {
  await withDatabase((database) => {
    const checkpoints = createToolCheckpoints({ database, riskOf });
    const conversation = database.createConversation({ title: "Resumed after approval" });
    const first = call("propose_edit", { path: "notes/a.md", body: "hello" });

    assert.equal(checkpoints.find(conversation.id, first), null, "nothing to replay before it has run");

    // The turn runs the tool and stores its result, exactly as the chat loop does.
    database.addMessage({
      conversationId: conversation.id,
      role: "tool",
      content: JSON.stringify({ proposalId: "p1", status: "created" }),
      status: "complete",
      toolName: "propose_edit",
      toolCallId: first.id,
      metadata: { runId: "run-1", checkpoint: checkpoints.stamp(conversation.id, first) }
    });

    // The turn is resumed. Same request, new call id — which is the whole
    // reason the call id cannot be the key.
    const replayed = call("propose_edit", { body: "hello", path: "notes/a.md" });
    assert.notEqual(replayed.id, first.id);
    const found = checkpoints.find(conversation.id, replayed);
    assert.ok(found, "the resumed turn must recognise the write it already made");
    assert.equal(found.runId, "run-1");
    assert.equal(JSON.parse(found.output).proposalId, "p1");
  });
});

test("a read is left to run again, and a failure is not replayed as a success", async () => {
  await withDatabase((database) => {
    const checkpoints = createToolCheckpoints({ database, riskOf });
    const conversation = database.createConversation({ title: "What is not checkpointed" });

    const read = call("read_file", { path: "a.md" });
    assert.equal(checkpoints.stamp(conversation.id, read), null, "a read is never stamped");
    database.addMessage({
      conversationId: conversation.id, role: "tool", content: "old contents", status: "complete",
      toolName: "read_file", toolCallId: read.id, metadata: { checkpoint: checkpointSignature(conversation.id, read) }
    });
    assert.equal(checkpoints.find(conversation.id, read), null, "even a stamped read is not served from a checkpoint");

    // A tool still waiting on a person has not had its effect yet; replaying it
    // would skip the approval rather than honour it.
    const pending = call("propose_edit", { path: "b.md" });
    database.addMessage({
      conversationId: conversation.id, role: "tool", content: "{}", status: "pending-approval",
      toolName: "propose_edit", toolCallId: pending.id, metadata: { checkpoint: checkpoints.stamp(conversation.id, pending) }
    });
    assert.equal(checkpoints.find(conversation.id, pending), null);

    // And a failure deserves a real second attempt.
    const failed = call("sandbox_write", { name: "x" });
    database.addMessage({
      conversationId: conversation.id, role: "tool", content: "{\"error\":\"disk full\"}", status: "error",
      toolName: "sandbox_write", toolCallId: failed.id, metadata: { checkpoint: checkpoints.stamp(conversation.id, failed) }
    });
    assert.equal(checkpoints.find(conversation.id, failed), null);
  });
});

test("a checkpoint stays inside its conversation", async () => {
  await withDatabase((database) => {
    const checkpoints = createToolCheckpoints({ database, riskOf });
    const mine = database.createConversation({ title: "Mine" });
    const theirs = database.createConversation({ title: "Theirs" });
    const write = call("sandbox_write", { name: "shared" });
    database.addMessage({
      conversationId: mine.id, role: "tool", content: "written", status: "complete",
      toolName: "sandbox_write", toolCallId: write.id, metadata: { checkpoint: checkpoints.stamp(mine.id, write) }
    });
    assert.ok(checkpoints.find(mine.id, write));
    assert.equal(checkpoints.find(theirs.id, write), null, "another conversation must run it itself");
  });
});

test("the model is told the call did not run again", () => {
  const notice = checkpointNotice("{\"proposalId\":\"p1\"}");
  assert.match(notice, /^\{"proposalId":"p1"\}\n/, "the result comes first and unaltered");
  assert.match(notice, /not run again/, "and the model is told plainly that nothing happened twice");
});

test("the chat loop checks the checkpoint before spending budget or calling the tool", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const lookup = server.indexOf("toolCheckpoints.find(conversationId, call)");
  const budget = server.indexOf("agentRuntime.consumeBudget(agentRunId, { toolCalls: 1 })");
  const execute = server.indexOf("toolRegistry.execute(call.function.name");
  assert.ok(lookup > 0 && budget > 0 && execute > 0);
  assert.ok(lookup < budget, "a call answered from a checkpoint must not be charged for");
  assert.ok(lookup < execute, "and must not reach the registry, where it would file a second proposal");
});

test("one rejected tool does not discard the results of the three beside it", async () => {
  // The batch runs concurrently. A sibling that already had its effect but
  // whose result was never written is the one that runs twice on resume, so
  // the rejection has to be carried past the recording loop rather than thrown
  // through it.
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const rejection = server.indexOf("batchFailure = batchFailure || outcome.reason");
  const store = server.indexOf("role: \"tool\",", rejection);
  const rethrow = server.indexOf("if (batchFailure) throw batchFailure", rejection);
  assert.ok(rejection > 0 && store > 0 && rethrow > 0);
  assert.ok(store < rethrow, "every settled sibling is recorded before the turn ends");
});
