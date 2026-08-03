import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { AgentRuntime } from "../lib/agent-runtime.mjs";
import { validateGoalPlan } from "../lib/goal-contracts.mjs";
import { ObsidianVaultService } from "../lib/obsidian-vault.mjs";

function samplePlan() {
  return { summary: "Inspect then verify", steps: [
    { id: "inspect", title: "Inspect project", description: "List approved project files.", type: "tool", tool: "list_workspace_files", inputs: { path: "." }, expectedEvidence: "File list" },
    { id: "verify", title: "Verify result", description: "Compare evidence with the goal.", type: "verification", dependencies: ["inspect"], verificationCriteria: "Every criterion has evidence." }
  ] };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-goal-"));
  const database = createDatabase({ dataDir: path.join(root, "data"), defaultPrompt: "Test" });
  const stamp = new Date().toISOString();
  database.raw.prepare(`INSERT INTO projects(id,name,description,status,is_default,created_at,updated_at) VALUES('project-1','Evolv Personal','Private project','active',1,?,?)`).run(stamp, stamp);
  const conversation = database.createConversation("Goal runner");
  return { root, database, runtime: new AgentRuntime(database), conversation };
}

test("goal plans reject cycles, unknown tools, escaping paths, missing verification, and oversized budgets", () => {
  assert.throws(() => validateGoalPlan({ summary: "Bad", steps: [{ id: "a", title: "A", description: "A", type: "tool", tool: "shell" }] }, { availableTools: [] }), (error) => error.code === "GOAL_TOOL_UNKNOWN");
  assert.throws(() => validateGoalPlan({ summary: "Bad", steps: [{ id: "a", title: "A", description: "A", type: "tool", tool: "list_workspace_files", inputs: { path: "../secret" } }, { id: "v", title: "V", description: "V", type: "verification", dependencies: ["a"] }] }, { availableTools: ["list_workspace_files"] }), (error) => error.code === "GOAL_PATH_REJECTED");
  assert.throws(() => validateGoalPlan({ summary: "Cycle", steps: [{ id: "a", title: "A", description: "A", type: "analyze", dependencies: ["b"] }, { id: "b", title: "B", description: "B", type: "verification", dependencies: ["a"] }] }), (error) => error.code === "GOAL_DEPENDENCY_CYCLE");
  assert.throws(() => validateGoalPlan({ summary: "No gate", steps: [{ id: "a", title: "A", description: "A", type: "analyze" }] }), (error) => error.code === "GOAL_VERIFICATION_REQUIRED");
  assert.throws(() => validateGoalPlan({ summary: "Long", steps: Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, title: "S", description: "S", type: index === 12 ? "verification" : "analyze" })) }), (error) => error.code === "GOAL_BUDGET_EXCEEDED");
});

test("multi-step goals require plan approval, preserve attempts, and complete only after verification", async (t) => {
  const { root, database, runtime, conversation } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  let run = runtime.createGoalRun({ conversationId: conversation.id, projectId: "project-1", objective: "Inspect safely", successCriteria: ["A file list is recorded"], providerId: "ollama", modelId: "test", plan: samplePlan(), availableTools: ["list_workspace_files"] });
  assert.equal(run.state, "waiting_for_approval");
  assert.throws(() => runtime.startGoal(run.id), (error) => error.code === "RUN_PLAN_APPROVAL_REQUIRED");
  run = runtime.approveGoalPlan(run.id);
  assert.equal(run.state, "paused");
  run = runtime.startGoal(run.id);
  assert.equal(run.steps[0].state, "running");
  let result = runtime.completeGoalStep(run.id, run.steps[0].id, { output: { files: ["README.md"] }, evidence: { title: "Files", payload: { files: ["README.md"] } } });
  runtime.leaseStep(run.id, result.nextStep.id);
  result = runtime.completeGoalStep(run.id, result.nextStep.id, { output: { verified: true, criteria: [{ criterion: "A file list is recorded", met: true }] }, evidence: { kind: "verification", title: "Gate" } });
  assert.equal(result.run.state, "completed");
  assert.equal(result.run.goal.status, "completed");
  assert.equal(result.run.steps[0].attemptsHistory[0].state, "completed");
  assert.ok(result.run.events.some((event) => event.type === "plan.approved"));
});

test("an unverified final result remains honest and does not complete", async (t) => {
  const { root, database, runtime, conversation } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  let run = runtime.createGoalRun({ conversationId: conversation.id, projectId: "project-1", objective: "Verify honestly", successCriteria: ["Evidence exists"], providerId: "ollama", modelId: "test", plan: samplePlan(), availableTools: ["list_workspace_files"] });
  runtime.approveGoalPlan(run.id); run = runtime.startGoal(run.id);
  let result = runtime.completeGoalStep(run.id, run.steps[0].id, { output: {} });
  runtime.leaseStep(run.id, result.nextStep.id);
  result = runtime.completeGoalStep(run.id, result.nextStep.id, { output: { verified: false, gaps: ["No evidence"] } });
  assert.equal(result.run.state, "failed");
  assert.equal(result.run.goal.status, "partial");
  assert.match(result.run.error, /without evidence/i);
});

test("approved plans create conflict-safe append-only Obsidian run journals", async (t) => {
  const { root, database, runtime, conversation } = await fixture();
  const vault = path.join(root, "vault"); await mkdir(vault, { recursive: true });
  const host = { consumeGrant: () => vault, claimRoot: (_profile, selected) => selected, releaseRoot() {}, openVault() { return { ok: true }; } };
  const service = new ObsidianVaultService({ database, profileId: "profile", host });
  t.after(async () => { service.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  await service.connectGrant("grant");
  let run = runtime.createGoalRun({ conversationId: conversation.id, projectId: "project-1", objective: "Journal the run", successCriteria: ["Journal exists"], providerId: "ollama", modelId: "test", plan: samplePlan(), availableTools: ["list_workspace_files"] });
  runtime.approveGoalPlan(run.id); run = runtime.get(run.id);
  const project = { id: "project-1", name: "Evolv Personal", description: "Private project" };
  const first = await service.syncRunJournal({ run, project });
  const journal = service.journalForRun(run.id);
  const content = await readFile(path.join(vault, journal.relativePath), "utf8");
  assert.match(content, /Approved plan/);
  assert.match(content, new RegExp(`run_id: ${run.id}`));
  assert.ok(first.appended > 0);
  const second = await service.syncRunJournal({ run: runtime.get(run.id), project });
  assert.equal(second.appended, 0);
  const eventIds = [...content.matchAll(/evolv-event:([0-9a-f-]+)/g)].map((match) => match[1]);
  assert.equal(new Set(eventIds).size, eventIds.length);
});
