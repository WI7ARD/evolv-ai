import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { AgentRuntime } from "../lib/agent-runtime.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-agent-runtime-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test" });
  const conversation = database.createConversation({ title: "Agent runtime" });
  const runtime = new AgentRuntime(database, options);
  return { root, database, conversation, runtime };
}

test("chat runs persist plans, leased steps, ordered events, checkpoints, and bounded budgets", async (t) => {
  const { root, database, conversation, runtime } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = runtime.createChatRun({
    conversationId: conversation.id,
    objective: "Build and verify a feature",
    providerId: "ollama",
    modelId: "test-model",
    request: { model: "test-model", mode: "standard" },
    budgets: { maxSteps: 1, maxToolCalls: 2, maxTokens: 1000, maxCostUnits: 0 }
  });
  assert.equal(run.state, "executing");
  assert.equal(run.plans.length, 1);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].state, "running");
  assert.equal(run.steps[0].attempts, 1);
  assert.ok(run.events.length >= 7);
  assert.deepEqual(run.events.map((event) => event.sequence), run.events.map((_event, index) => index + 1));
  assert.ok(run.checkpoints.some((checkpoint) => checkpoint.data.phase === "before-lease"));
  assert.ok(run.checkpoints.some((checkpoint) => checkpoint.data.phase === "after-lease"));
  assert.equal(run.budgets.maxToolCalls, 2);
  assert.deepEqual(run.request, { model: "test-model", mode: "standard" });

  const rerouted = runtime.updateRoute(run.id, {
    providerId: "ollama", modelId: "fallback-model", reason: "requested model unavailable"
  });
  assert.equal(rerouted.modelId, "fallback-model");
  assert.ok(rerouted.events.some((event) => event.type === "routing.fallback" && event.payload.modelId === "fallback-model"));

  assert.throws(() => runtime.createChatRun({
    conversationId: conversation.id,
    objective: "Duplicate",
    providerId: "ollama",
    modelId: "test-model"
  }), (error) => error.code === "RUN_ALREADY_ACTIVE");

  runtime.recordEffect(run.id, run.steps[0].id, "before", "tool.execute", { toolName: "calculate" });
  runtime.consumeBudget(run.id, { toolCalls: 1 });
  runtime.recordEffect(run.id, run.steps[0].id, "after", "tool.execute", { ok: true });
  const completed = runtime.complete(run.id, { output: { verified: true }, tokens: 25 });
  assert.equal(completed.state, "completed");
  assert.equal(completed.steps[0].state, "completed");
  assert.equal(completed.steps[0].result.verified, true);
  assert.equal(completed.budgets.usedSteps, 1);
  assert.equal(completed.budgets.usedToolCalls, 1);
  assert.equal(completed.budgets.usedTokens, 25);
  assert.deepEqual(completed.events.filter((event) => event.type === "state.transition.completed").map((event) => event.payload.to), [
    "planning", "executing", "observing", "evaluating", "completed"
  ]);
});

test("pause, approval, resume, cancellation, and budget failures use explicit legal states", async (t) => {
  const { root, database, conversation, runtime } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = runtime.createChatRun({
    conversationId: conversation.id,
    objective: "Approval flow",
    providerId: "ollama",
    modelId: "test",
    budgets: { maxToolCalls: 1, maxRetries: 3 }
  });
  const waiting = runtime.waitForApproval(run.id, { toolRunId: "tool-1", toolName: "propose_workspace_edit" });
  assert.equal(waiting.state, "waiting_for_approval");
  assert.equal(waiting.steps[0].state, "pending");
  const ready = runtime.releaseApproval(run.id, "approved");
  assert.equal(ready.state, "paused");
  const resumed = runtime.prepareResume(run.id, conversation.id);
  assert.equal(resumed.state, "executing");
  assert.equal(resumed.steps[0].attempts, 2);
  runtime.consumeBudget(run.id, { toolCalls: 1 });
  assert.throws(() => runtime.consumeBudget(run.id, { toolCalls: 1 }), (error) => error.code === "RUN_BUDGET_EXCEEDED");
  const cancelled = runtime.cancel(run.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.steps[0].state, "cancelled");
  assert.throws(() => runtime.prepareResume(run.id, conversation.id), (error) => error.code === "RUN_NOT_PAUSED");
});

test("startup recovery pauses abandoned leases without touching approval or terminal runs", async (t) => {
  const { root, database, conversation, runtime } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = runtime.createChatRun({
    conversationId: conversation.id,
    objective: "Recover me",
    providerId: "ollama",
    modelId: "test"
  });
  const recovered = new AgentRuntime(database).recoverAbandonedRuns();
  assert.deepEqual(recovered, { paused: 1 });
  const paused = runtime.get(run.id);
  assert.equal(paused.state, "paused");
  assert.equal(paused.steps[0].state, "pending");
  assert.ok(paused.events.some((event) => event.type === "state.transition.completed"
    && event.payload.to === "paused" && /application restarted/.test(event.payload.reason)));
  assert.deepEqual(new AgentRuntime(database).recoverAbandonedRuns(), { paused: 0 });
});
