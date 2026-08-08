import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMockOllama } from "./helpers/mock-ollama.mjs";
import { createAuthenticatedClient } from "./helpers/auth-client.mjs";

const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let mock;
let dataDir;
let client;

// The approval test proposes a file below this directory. The engineering
// action service requires the parent to already exist, and `work/` is ignored
// by Git, so a clean checkout has to create it rather than inherit it from
// whatever happens to be lying around in the developer's tree.
const scratchDir = path.join(fileURLToPath(new URL("..", import.meta.url)), "work");
let ownsScratchDir = false;

test.before(async () => {
  ownsScratchDir = !existsSync(scratchDir);
  await mkdir(scratchDir, { recursive: true });
  dataDir = await mkdtemp(path.join(tmpdir(), "evolv-stream-"));
  mock = await startMockOllama();
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OLLAMA_URL: mock.url,
      EVOLV_DATA_DIR: dataDir,
      EVOLV_DB_PATH: path.join(dataDir, "test.db"),
      EVOLV_SCRYPT_N: "1024",
      OLLAMA_STREAM_IDLE_MS: "300",
      OLLAMA_LOAD_TIMEOUT_MS: "2000"
    },
    stdio: "ignore"
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/auth/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Server did not become ready.");
  client = await createAuthenticatedClient(BASE);
});

test.after(async () => {
  child?.kill();
  await mock?.close();
  await delay(150);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (ownsScratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
});

async function createConversation(title) {
  const response = await client.fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function chat(conversationId, body, { signal } = {}) {
  const response = await client.fetch(`/api/conversations/${conversationId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  return response;
}

async function readEvents(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

async function loadConversation(conversationId) {
  return (await client.fetch(`/api/conversations/${conversationId}`)).json();
}

test("approved Agent goals stream safe steps, evidence, verification, and durable completion", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [{ content: JSON.stringify({ verified: true, criteria: [{ criterion: "The result equals four", met: true, evidence: "calculate returned 4" }], gaps: [], summary: "Verified" }) }]);
  const project = (await (await client.fetch("/api/projects")).json()).projects[0];
  const createdResponse = await client.fetch("/api/agent-goals", { method: "POST", body: JSON.stringify({
    objective: "Calculate two plus two and verify it",
    successCriteria: ["The result equals four"], projectId: project.id, provider: "ollama", model: "mock-model",
    plan: { summary: "Calculate then verify", steps: [
      { id: "calculate", title: "Calculate", description: "Use restricted arithmetic.", type: "tool", tool: "calculate", inputs: { expression: "2+2" } },
      { id: "verify", title: "Verify", description: "Check the result against the criterion.", type: "verification", dependencies: ["calculate"] }
    ] }
  }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal((await client.fetch(`/api/runs/${created.id}/plan/approve`, { method: "POST", body: "{}" })).status, 200);
  const stream = await client.fetch(`/api/runs/${created.id}/start`, { method: "POST", body: "{}" });
  assert.equal(stream.status, 200);
  const events = await readEvents(stream);
  assert.equal(events[0].type, "plan");
  assert.ok(events.some((event) => event.type === "routing"));
  assert.ok(events.some((event) => event.type === "step" && event.action === "completed"));
  assert.ok(events.some((event) => event.type === "evidence"));
  assert.ok(events.some((event) => event.type === "verification"));
  assert.equal(events.at(-1).type, "completion");
  assert.equal(events.at(-1).verified, true);
  const persisted = await (await client.fetch(`/api/runs/${created.id}`)).json();
  assert.equal(persisted.state, "completed");
  assert.equal(persisted.goal.status, "completed");
  assert.ok(persisted.evidence.length >= 2);
  assert.equal(persisted.steps.every((step) => step.attemptsHistory.length === 1), true);
});

test("clean stream persists content with complete status", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [{ content: "Hello " }, { content: "world." }]);
  const conversation = await createConversation("clean");
  const response = await chat(conversation.id, { text: "hi", model: "clean-model" });
  assert.equal(response.status, 200);
  const events = await readEvents(response);
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  assert.equal(content, "Hello world.");
  assert.equal(events.at(-1).type, "complete");
  assert.equal(events.at(-1).status, "complete");
  const runEvent = events.find((event) => event.type === "run" && event.state === "completed");
  assert.ok(runEvent?.runId);
  const persistedRun = await (await client.fetch(`/api/runs/${runEvent.runId}`)).json();
  assert.equal(persistedRun.state, "completed");
  assert.equal(persistedRun.steps[0].state, "completed");
  assert.ok(persistedRun.events.some((event) => event.type === "effect.before" && event.payload.effect === "model.stream"));
  assert.ok(persistedRun.events.some((event) => event.type === "effect.after" && event.payload.effect === "model.stream"));
  const loaded = await loadConversation(conversation.id);
  const assistant = loaded.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content, "Hello world.");
  assert.equal(assistant.status, "complete");
  const evolution = await (await client.fetch("/api/evolution")).json();
  const evaluation = evolution.evaluations.find((item) => item.runId === runEvent.runId);
  assert.ok(evaluation);
  assert.equal(evaluation.metrics.completion, 1);
  assert.equal(evaluation.metrics.quality, null);
  assert.equal(evaluation.evidence.judgeCallUsed, false);
});

test("Auto emits and persists a transparent balanced routing decision", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript((body) => body.format ? [{ content: '{"proposals":[]}' }] : [{ content: "Auto answer." }]);
  const conversation = await createConversation("auto-route");
  const response = await chat(conversation.id, { text: "Say hello", model: "auto" });
  assert.equal(response.status, 200);
  const events = await readEvents(response);
  const routing = events.find((event) => event.type === "routing");
  assert.equal(routing.automatic, true);
  assert.equal(routing.provider, "ollama");
  assert.equal(routing.cloud, false);
  const loaded = await loadConversation(conversation.id);
  const assistant = loaded.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.model, "mock-model");
  assert.equal(assistant.metadata.routing.automatic, true);
  assert.equal(assistant.metadata.routing.provider, "ollama");
});

test("think-tag leakage is rerouted into the thinking channel", async () => {
  mock.setCapabilities(["completion", "thinking"]);
  mock.setScript(() => [
    { content: "First I reason about the problem in private. " },
    { content: "Then I keep reasoning.</thi" },
    { content: "nk>\n\nThe answer is 42." }
  ]);
  const conversation = await createConversation("leak");
  const response = await chat(conversation.id, { text: "solve", model: "leak-model", think: false });
  const events = await readEvents(response);
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  const reasoning = events.filter((event) => event.type === "reasoning").map((event) => event.delta).join("");
  assert.equal(content, "The answer is 42.");
  assert.ok(reasoning.includes("First I reason"));
  assert.ok(!content.includes("</think>"));
  const loaded = await loadConversation(conversation.id);
  const assistant = loaded.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content, "The answer is 42.");
  assert.ok(assistant.thinking.includes("keep reasoning"));
});

test("explicit think tag pairs are stripped from content", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [
    { content: "Before. <thi" },
    { content: "nk>hidden reasoning</think> After." }
  ]);
  const conversation = await createConversation("tags");
  const response = await chat(conversation.id, { text: "go", model: "tag-model" });
  const events = await readEvents(response);
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  assert.equal(content, "Before.  After.");
  const reasoning = events.filter((event) => event.type === "reasoning").map((event) => event.delta).join("");
  assert.equal(reasoning, "hidden reasoning");
});

test("stalled stream trips the idle watchdog and records an error", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [{ content: "partial " }, "stall"]);
  const conversation = await createConversation("stall");
  const response = await chat(conversation.id, { text: "hang", model: "stall-model" });
  const events = await readEvents(response);
  const errorEvent = events.find((event) => event.type === "error");
  assert.ok(errorEvent, "expected an error event");
  assert.match(errorEvent.error, /stopped responding/);
  const complete = events.findLast((event) => event.type === "complete");
  assert.equal(complete.status, "error");
  const loaded = await loadConversation(conversation.id);
  const assistant = loaded.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.status, "error");
  const runs = await (await client.fetch(`/api/runs?conversationId=${conversation.id}`)).json();
  assert.equal(runs.runs[0].state, "failed");
});

test("client abort mid-stream marks the message interrupted", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [
    { content: "chunk one " },
    { delayMs: 80 },
    { content: "chunk two " },
    { delayMs: 2_000 },
    { content: "never seen" }
  ]);
  const conversation = await createConversation("abort");
  const controller = new AbortController();
  const response = await chat(conversation.id, { text: "long", model: "abort-model" }, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read(); // consume the first bytes, then walk away
  controller.abort();
  let assistant;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    const loaded = await loadConversation(conversation.id);
    assistant = loaded.messages.find((message) => message.role === "assistant");
    if (assistant && assistant.status !== "streaming") break;
  }
  assert.equal(assistant.status, "interrupted");
  const runs = await (await client.fetch(`/api/runs?conversationId=${conversation.id}`)).json();
  assert.equal(runs.runs[0].state, "paused");
});

test("an active run can pause, persist its checkpoint, and resume the same step", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [
    { content: "partial work " },
    { delayMs: 2_000 },
    { content: "not completed" }
  ]);
  const conversation = await createConversation("pause-resume");
  const response = await chat(conversation.id, { text: "work carefully", model: "pause-model" });
  let activeRun;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await (await client.fetch(`/api/runs?conversationId=${conversation.id}`)).json();
    activeRun = payload.runs[0];
    if (activeRun?.state === "executing") break;
    await delay(20);
  }
  assert.equal(activeRun.state, "executing");
  const pausedResponse = await client.fetch(`/api/runs/${activeRun.id}/pause`, { method: "POST", body: "{}" });
  assert.equal(pausedResponse.status, 200);
  assert.equal((await pausedResponse.json()).state, "paused");
  const pausedEvents = await readEvents(response);
  assert.equal(pausedEvents.findLast((event) => event.type === "run").state, "paused");

  mock.setScript(() => [{ content: "Resumed and verified." }]);
  const resumedResponse = await client.fetch(`/api/runs/${activeRun.id}/resume`, { method: "POST", body: "{}" });
  assert.equal(resumedResponse.status, 200);
  const resumedEvents = await readEvents(resumedResponse);
  assert.equal(resumedEvents.findLast((event) => event.type === "run").state, "completed");
  const completed = await (await client.fetch(`/api/runs/${activeRun.id}`)).json();
  assert.equal(completed.state, "completed");
  assert.equal(completed.steps[0].attempts, 2);
  assert.ok(completed.events.some((event) => event.type === "state.transition.completed" && event.payload.to === "paused"));
});

test("cancelling an active run aborts generation and prevents resume", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [{ content: "starting " }, { delayMs: 2_000 }, { content: "too late" }]);
  const conversation = await createConversation("cancel-run");
  const response = await chat(conversation.id, { text: "cancel this", model: "cancel-model" });
  let activeRun;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    activeRun = (await (await client.fetch(`/api/runs?conversationId=${conversation.id}`)).json()).runs[0];
    if (activeRun?.state === "executing") break;
    await delay(20);
  }
  const cancelled = await client.fetch(`/api/runs/${activeRun.id}/cancel`, { method: "POST", body: "{}" });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).state, "cancelled");
  const events = await readEvents(response);
  assert.equal(events.findLast((event) => event.type === "run").state, "cancelled");
  const resume = await client.fetch(`/api/runs/${activeRun.id}/resume`, { method: "POST", body: "{}" });
  assert.equal(resume.status, 409);
});

test("approval-required tools pause the run and a reviewed decision resumes the same run", async () => {
  mock.setCapabilities(["completion", "tools"]);
  mock.setScript(() => [{
    tool_calls: [{
      function: {
        name: "propose_workspace_create",
        arguments: {
          path: "work/agent-runtime-review-only.txt",
          content: "This proposal is rejected by the test and must never be written.",
          summary: "Verify the run approval boundary."
        }
      }
    }]
  }]);
  const conversation = await createConversation("agent-approval");
  const events = await readEvents(await chat(conversation.id, { text: "propose a test file", model: "tool-model" }));
  const toolResult = events.find((event) => event.type === "tool_result");
  const waiting = events.findLast((event) => event.type === "run");
  assert.equal(toolResult.status, "approval_required");
  assert.equal(waiting.state, "waiting_for_approval");
  const rejectedResponse = await client.fetch(`/api/tool-runs/${toolResult.runId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision: "rejected" })
  });
  assert.equal(rejectedResponse.status, 200);
  const rejected = await rejectedResponse.json();
  assert.equal(rejected.agentRunId, waiting.runId);
  assert.equal(rejected.continuationAvailable, true);
  assert.equal((await (await client.fetch(`/api/runs/${waiting.runId}`)).json()).state, "paused");

  mock.setScript(() => [{ content: "The proposed file was rejected and no change was made." }]);
  const resumed = await readEvents(await chat(conversation.id, {
    continuation: true,
    resumeRunId: waiting.runId,
    model: "tool-model"
  }));
  assert.equal(resumed.findLast((event) => event.type === "run").state, "completed");
});

test("tool loop stops at the round limit", async () => {
  mock.setCapabilities(["completion", "tools"]);
  mock.setScript((body, callIndex) => [
    { tool_calls: [{ function: { name: "calculate", arguments: { expression: `${callIndex + 1}+${callIndex}` } } }] }
  ]);
  const conversation = await createConversation("loop");
  const response = await chat(conversation.id, { text: "loop forever", model: "loop-model" });
  const events = await readEvents(response);
  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(errorEvent.code, "TOOL_LOOP_LIMIT");
  const complete = events.findLast((event) => event.type === "complete");
  assert.equal(complete.status, "limit");
  assert.equal(events.filter((event) => event.type === "tool_result").length, 4);
});

test("a round's tool calls run four at a time, in order, without racing an approval", async () => {
  const { batchToolCalls, TOOL_BATCH_SIZE } = await import("../lib/tool-batching.mjs");
  const call = (name) => ({ id: name, function: { name, arguments: {} } });
  // Only the automatic tiers may overlap; an approval-gated tool suspends the
  // whole run the moment it returns, so it is never started beside a sibling.
  const registry = { isAutomatic: (name) => name.startsWith("read") };

  assert.equal(TOOL_BATCH_SIZE, 4);
  assert.deepEqual(
    batchToolCalls(["read1", "read2", "read3", "read4", "read5"].map(call), registry).map((batch) => batch.map((entry) => entry.id)),
    [["read1", "read2", "read3", "read4"], ["read5"]],
    "a fifth call waits for the next batch rather than widening this one"
  );
  assert.deepEqual(
    batchToolCalls(["read1", "propose", "read2", "read3"].map(call), registry).map((batch) => batch.map((entry) => entry.id)),
    [["read1"], ["propose"], ["read2", "read3"]],
    "the approval-gated call gets a batch to itself and does not reorder its neighbours"
  );
  // A registry that cannot answer is treated as gated: refusing to parallelize
  // is the safe guess, and an unknown name is about to fail anyway.
  assert.deepEqual(
    batchToolCalls([call("a"), call("b")], {}).map((batch) => batch.length),
    [1, 1]
  );
});

test("four tools asked for at once are executed together and recorded in order", async () => {
  mock.setCapabilities(["completion", "tools"]);
  const expressions = ["1+1", "2+2", "3+3", "4+4"];
  mock.setScript((body) => {
    if (body.messages.some((message) => message.role === "tool")) return [{ content: "All four are done." }];
    return [{
      tool_calls: expressions.map((expression, index) => ({
        id: `call-${index}`,
        function: { name: "calculate", arguments: { expression } }
      }))
    }];
  });
  const conversation = await createConversation("batch");
  const events = await readEvents(await chat(conversation.id, { text: "four sums", model: "batch-model" }));

  // All four are announced as running before any of them reports back, which
  // is what running concurrently looks like from the outside.
  const kinds = events.filter((event) => event.type === "tool_request" || event.type === "tool_result").map((event) => event.type);
  assert.deepEqual(kinds, ["tool_request", "tool_request", "tool_request", "tool_request",
    "tool_result", "tool_result", "tool_result", "tool_result"]);

  // The transcript still reads in the order the model asked, whatever order
  // they actually finished in.
  const outputs = events.filter((event) => event.type === "tool_result").map((event) => event.output);
  assert.deepEqual(outputs.map((output) => JSON.parse(output).result), [2, 4, 6, 8]);

  // The persisted transcript is what the model reads back on the next round,
  // so its order is the one that actually matters.
  const persisted = await (await client.fetch(`/api/conversations/${conversation.id}`)).json();
  const toolMessages = persisted.messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => JSON.parse(message.content).result), [2, 4, 6, 8]);
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), ["call-0", "call-1", "call-2", "call-3"]);
});

test("identical calls inside one batch still execute only once", async () => {
  mock.setCapabilities(["completion", "tools"]);
  mock.setScript((body) => {
    if (body.messages.some((message) => message.role === "tool")) return [{ content: "Both agree." }];
    return [{
      tool_calls: [
        { id: "same-a", function: { name: "calculate", arguments: { expression: "7+7" } } },
        { id: "same-b", function: { name: "calculate", arguments: { expression: "7+7" } } }
      ]
    }];
  });
  const conversation = await createConversation("batch-dupe");
  const events = await readEvents(await chat(conversation.id, { text: "twice", model: "batch-dupe-model" }));

  // Concurrency is where the dedupe map is easiest to break: both calls look
  // up an empty cache at the same instant unless the map holds the in-flight
  // promise rather than the settled result.
  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 2);
  assert.equal(Boolean(results[0].cached), false);
  assert.equal(results[1].cached, true);
  assert.match(results[1].output, /duplicate call/);

  const runsPayload = await (await client.fetch("/api/tool-runs?limit=200")).json();
  const runs = runsPayload.runs.filter((run) => run.conversationId === conversation.id);
  assert.equal(runs.length, 1, "the duplicate must not have executed a second tool run");
});

test("duplicate tool calls reuse the cached result", async () => {
  mock.setCapabilities(["completion", "tools"]);
  mock.setScript((body, callIndex) => {
    const round = body.messages.filter((message) => message.role === "tool").length;
    if (round < 2) {
      return [{ tool_calls: [{ function: { name: "calculate", arguments: { expression: "2+2" } } }] }];
    }
    return [{ content: "The result is 4." }];
  });
  const conversation = await createConversation("dupe");
  const response = await chat(conversation.id, { text: "compute", model: "dupe-model" });
  const events = await readEvents(response);
  const results = events.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 2);
  assert.equal(Boolean(results[0].cached), false);
  assert.equal(results[1].cached, true);
  assert.match(results[1].output, /duplicate call/);
  const runsPayload = await (await client.fetch("/api/tool-runs?limit=200")).json();
  const runs = runsPayload.runs.filter((run) => run.conversationId === conversation.id);
  assert.equal(runs.length, 1, "duplicate must not execute a second tool run");
});

test("a malformed stream line is skipped without killing the response", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [
    { content: "Good " },
    { raw: "{{{ not json at all" },
    { content: "reply." }
  ]);
  const conversation = await createConversation("garbage");
  const response = await chat(conversation.id, { text: "hi", model: "garbage-model" });
  const events = await readEvents(response);
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  assert.equal(content, "Good reply.");
  assert.equal(events.at(-1).type, "complete");
  assert.equal(events.at(-1).status, "complete");
});

test("regenerate appends a fresh assistant reply without a new user message", async () => {
  mock.setCapabilities(["completion"]);
  mock.setScript(() => [{ content: "First answer." }]);
  const conversation = await createConversation("regen");
  await readEvents(await chat(conversation.id, { text: "original question", model: "regen-model" }));

  mock.setScript(() => [{ content: "Second answer." }]);
  const regenerated = await chat(conversation.id, { regenerate: true, model: "regen-model" });
  assert.equal(regenerated.status, 200);
  const events = await readEvents(regenerated);
  assert.equal(events.at(-1).status, "complete");

  const loaded = await loadConversation(conversation.id);
  const userMessages = loaded.messages.filter((message) => message.role === "user");
  const assistantMessages = loaded.messages.filter((message) => message.role === "assistant");
  assert.equal(userMessages.length, 1, "regeneration must not add a user turn");
  assert.equal(assistantMessages.length, 2, "regeneration appends a fresh assistant reply");
  assert.equal(assistantMessages.at(-1).content, "Second answer.");
  // Continual memory inspection may make a structured follow-up request after
  // the response; locate the generation request instead of assuming it is last.
  const generationRequest = mock.chatRequests.findLast((request) =>
    request.messages.some((message) => message.role === "user" && message.content === "original question"));
  assert.ok(generationRequest);

  const empty = await createConversation("regen-empty");
  const rejected = await chat(empty.id, { regenerate: true, model: "regen-model" });
  assert.equal(rejected.status, 400, "regenerating with no user turn is rejected");
});

test("images are rejected for non-vision models and forwarded for vision models", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69f2WQAAAABJRU5ErkJggg==";
  mock.setCapabilities(["completion"]);
  const textConversation = await createConversation("no-vision");
  const rejected = await chat(textConversation.id, { text: "look", model: "text-only-model", images: [image] });
  assert.equal(rejected.status, 400);

  mock.setCapabilities(["completion", "vision"]);
  mock.setScript(() => [{ content: "I can see the image." }]);
  const visionConversation = await createConversation("vision");
  const accepted = await chat(visionConversation.id, { text: "look", model: "vision-model", images: [image] });
  assert.equal(accepted.status, 200);
  const events = await readEvents(accepted);
  assert.equal(events.at(-1).status, "complete");
  const lastRequest = mock.chatRequests.at(-1);
  const userMessage = lastRequest.messages.findLast((message) => message.role === "user");
  assert.deepEqual(userMessage.images, [image]);
  const loaded = await loadConversation(visionConversation.id);
  const persisted = loaded.messages.find((message) => message.role === "user");
  assert.deepEqual(persisted.metadata.images, [image]);
});
