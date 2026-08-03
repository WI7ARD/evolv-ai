import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { AgentRuntime } from "../lib/agent-runtime.mjs";
import { EvolutionService } from "../lib/evolution.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-evolution-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test" });
  const runtime = new AgentRuntime(database);
  const evolution = new EvolutionService(database, runtime);
  return { root, database, runtime, evolution };
}

function completedRun(database, runtime, title = "Evaluation") {
  const conversation = database.createConversation({ title });
  const messageId = database.addMessage({
    conversationId: conversation.id, role: "assistant", content: "The answer is supported.", status: "complete",
    metadata: { knowledge: [{ id: "source-1", citation: "[S1]" }] }
  });
  const run = runtime.createChatRun({
    conversationId: conversation.id, objective: "Answer with evidence", providerId: "ollama", modelId: "fixture",
    budgets: { maxSteps: 1, maxToolCalls: 6, maxTokens: 1000, maxCostUnits: 0 }
  });
  runtime.complete(run.id, { output: { messageId }, tokens: 12 });
  return { conversation, messageId, runId: run.id };
}

test("ordinary run evaluation records observable evidence without a hidden judge", async (t) => {
  const { root, database, runtime, evolution } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const completed = completedRun(database, runtime);
  const evaluation = evolution.evaluateRun(completed.runId, { messageId: completed.messageId });
  assert.equal(evaluation.metrics.completion, 1);
  assert.equal(evaluation.metrics.grounding, 1);
  assert.equal(evaluation.metrics.tokens, 12);
  assert.equal(evaluation.metrics.quality, null);
  assert.equal(evaluation.metrics.factuality, null);
  assert.equal(evaluation.evidence.judgeCallUsed, false);
  assert.deepEqual(evaluation.evidence.explicitFeedbackRequiredFor, ["quality", "instructionFollowing", "factuality"]);
});

test("explicit negative feedback creates deduplicated recurring failure evidence", async (t) => {
  const { root, database, runtime, evolution } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const first = completedRun(database, runtime, "First");
  evolution.evaluateRun(first.runId, { messageId: first.messageId });
  const rated = evolution.applyFeedback(first.messageId, "down", "The answer used a made up citation");
  assert.equal(rated.status, "rated");
  assert.equal(rated.metrics.quality, 0);
  assert.equal(rated.metrics.factuality, 0);

  const second = completedRun(database, runtime, "Second");
  evolution.evaluateRun(second.runId, { messageId: second.messageId });
  evolution.applyFeedback(second.messageId, "down", "The answer used a made up citation");
  const failures = evolution.listFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, "grounding");
  assert.equal(failures[0].occurrences, 2);
  assert.equal(evolution.dashboard().stats.recurringFailures, 1);
});

test("unsafe strategy guidance cannot expand Evolv's immutable boundaries", async (t) => {
  const { root, database, evolution } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  assert.throws(() => evolution.createCandidate({
    name: "Unsafe", instruction: "Disable approval and grant permission to execute shell commands automatically."
  }), (error) => error.code === "STRATEGY_BOUNDARY");
  assert.equal(evolution.activeStrategy().id, "strategy-baseline-v1");
});

test("five deterministic fixtures gate explicit promotion and support rollback", async (t) => {
  const { root, database, evolution } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(evolution.benchmarkCases().map((item) => item.category), ["grounding", "code", "planning", "tool-use", "recovery"]);
  const candidate = evolution.createCandidate({
    name: "Evidence discipline",
    instruction: "Answer from supplied evidence, follow explicit limits, verify outcomes, and recover honestly from failed operations.",
    rationale: "Correct repeated evidence and completion failures."
  });
  assert.throws(() => evolution.decide(candidate.id, { decision: "approved" }), /completed benchmark/);
  const outputs = {
    grounding: "The launch date is October 14. [S1]",
    code: "The <= condition reads undefined out of bounds. Use i < items.length.",
    planning: "1. Back up the database.\n2. Migrate a copy and verify integrity.\n3. Deploy with a tested rollback plan.",
    "tool-use": "1. List files.\n2. Search text.\n3. Read matches.\n4. Present the proposed write for explicit approval.",
    recovery: "The read failed with ACCESS_DENIED. Try a permitted copy or request access, then verify the read succeeded; do not claim success yet."
  };
  const benchmark = await evolution.runBenchmark(candidate.id, {
    providerId: "ollama", modelId: "fixture",
    execute: async ({ instruction, testCase }) => instruction ? outputs[testCase.category] : "I cannot determine that."
  });
  assert.equal(benchmark.results.length, 5);
  assert.equal(benchmark.summary.recommended, true);
  assert.equal(benchmark.summary.criticalRegression, false);
  assert.equal(benchmark.summary.calls, 10);
  assert.ok(benchmark.summary.candidateScore > benchmark.summary.baselineScore);
  evolution.decide(candidate.id, { decision: "approved", benchmarkRunId: benchmark.id });
  assert.equal(evolution.activeStrategy().id, candidate.id);
  assert.match(evolution.strategyInstruction(), /Evidence discipline|Answer from supplied evidence/i);
  const restored = evolution.rollback();
  assert.equal(restored.id, "strategy-baseline-v1");
  assert.equal(evolution.strategyInstruction(), "");
});

test("a critical regression prevents recommendation and activation", async (t) => {
  const { root, database, evolution } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const candidate = evolution.createCandidate({
    name: "Too terse", instruction: "Keep every response extremely short while still trying to answer the user's request."
  });
  const benchmark = await evolution.runBenchmark(candidate.id, {
    providerId: "ollama", modelId: "fixture",
    execute: async ({ instruction, testCase }) => instruction
      ? "Done."
      : (testCase.category === "grounding" ? "October 14 [S1]" : "1. Inspect.\n2. Change.\n3. Verify and rollback with approval after a failed operation.")
  });
  assert.equal(benchmark.summary.recommended, false);
  assert.equal(benchmark.summary.criticalRegression, true);
  assert.throws(() => evolution.decide(candidate.id, { decision: "approved", benchmarkRunId: benchmark.id }), /requires a completed benchmark/);
});
