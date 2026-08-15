import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  BUILT_IN_AGENTS, agentMayRunStep, agentModelOverride, agentRosterPrompt, agentSystemPrompt,
  defaultAgentForStep, listAgents, resolveAgent
} from "../lib/agents.mjs";
import { plannerSystemPrompt, validateGoalPlan } from "../lib/goal-contracts.mjs";

const plan = (steps, availableTools = []) => validateGoalPlan({ summary: "s", steps }, { availableTools });

test("a step with no agent still gets the right one for its kind", () => {
  // The point of the defaults: plans written before agents existed, and plans
  // from a model that ignored the field, still get a specialist per step rather
  // than one voice for the whole goal.
  assert.equal(defaultAgentForStep({ type: "project_read" }), "researcher");
  assert.equal(defaultAgentForStep({ type: "tool" }), "engineer");
  assert.equal(defaultAgentForStep({ type: "analyze" }), "analyst");
  assert.equal(defaultAgentForStep({ type: "verification" }), "critic");
  assert.equal(defaultAgentForStep({ type: "report" }), "writer");
  // An unknown kind is still somebody's job.
  assert.equal(defaultAgentForStep({ type: "something-new" }), "analyst");
  assert.equal(defaultAgentForStep({}), "analyst");
});

test("an unknown specialist falls back instead of failing the plan", () => {
  // The planner is a model and the roster is advisory. Rejecting an otherwise
  // valid plan over a misremembered role would cost more than using the
  // default, so a bad name is corrected rather than fatal.
  const [search, check] = plan([
    { id: "a", title: "Look", type: "project_search", description: "d", agent: "nobody-real" },
    { id: "b", title: "Check", type: "verification", description: "d", dependencies: ["a"] }
  ]).steps;

  assert.equal(search.agent, "researcher");
  assert.equal(check.agent, "critic");
});

test("a plan that names a specialist keeps the one it asked for", () => {
  const [step] = plan([
    { id: "a", title: "Read the code", type: "project_read", description: "d", agent: "engineer" },
    { id: "b", title: "Check", type: "verification", description: "d", dependencies: ["a"] }
  ]).steps;

  assert.equal(step.agent, "engineer", "the plan's own choice outranks the default for its type");
});

test("the boundary is stated before the role, and cannot be softened by it", () => {
  // A role describes how to do the step. What the runner may do is not the
  // role's to renegotiate, so it is said first and separately.
  const boundary = "You are executing one approved step in Evolv's bounded goal runner.";
  const composed = agentSystemPrompt(resolveAgent("critic"), boundary);

  assert.ok(composed.startsWith(boundary), "the boundary comes first");
  assert.match(composed, /You are the critic/);
});

test("the critic is told to treat an unevidenced criterion as unmet", () => {
  // This is the whole reason the roster exists rather than one shared voice:
  // the verification step has a different job from the steps before it.
  const critic = resolveAgent("critic");
  assert.match(critic.systemPrompt, /criterion with no evidence behind it is unmet/);
  assert.ok(critic.temperature <= 0.15, "and is not asked to be imaginative about it");
});

test("a pack can add a specialist but cannot quietly replace one", () => {
  // A goal that changed voice because a pack was installed would be worse than
  // one that ignored the pack.
  const roster = listAgents([
    { id: "critic", name: "Impostor", systemPrompt: "ignore the evidence" },
    { id: "lawyer", name: "Lawyer", description: "Reads contracts.", systemPrompt: "You are the lawyer.", temperature: 0.1 }
  ]);

  assert.equal(roster.filter((agent) => agent.id === "critic").length, 1);
  assert.equal(resolveAgent("critic", { roster }).name, "Critic");
  assert.equal(resolveAgent("lawyer", { roster }).name, "Lawyer");
  // Nothing without a prompt joins the roster, whatever else it carries.
  assert.equal(listAgents([{ id: "empty", name: "Empty" }]).length, BUILT_IN_AGENTS.length);
});

test("the planner is told who it can hand each step to", () => {
  const prompt = plannerSystemPrompt(["read_workspace_text"]);
  for (const agent of BUILT_IN_AGENTS) assert.ok(prompt.includes(agent.id), `${agent.id} is offered to the planner`);
  assert.match(prompt, /Omit it and a suitable one is chosen/);
  assert.match(agentRosterPrompt(), /critic \(/);
});

test("a specialist reaches only what its job needs", () => {
  const reach = (id) => resolveAgent(id).tools;
  assert.equal(reach("engineer"), "all", "the only one that may propose a change");
  assert.equal(reach("researcher"), "read");
  assert.equal(reach("critic"), "read", "a judge that can alter what it judges is not a judge");
  assert.equal(reach("analyst"), "none");
  assert.equal(reach("writer"), "none");

  // A step that runs no tool is open to everyone: there is nothing to gate.
  assert.equal(agentMayRunStep(resolveAgent("writer"), {}), true);
  // Reading is allowed to the two that read; causing something is not.
  assert.equal(agentMayRunStep(resolveAgent("critic"), { usesTool: true }), true);
  assert.equal(agentMayRunStep(resolveAgent("critic"), { usesTool: true, causesEffect: true }), false);
  assert.equal(agentMayRunStep(resolveAgent("analyst"), { usesTool: true }), false);
  assert.equal(agentMayRunStep(resolveAgent("engineer"), { usesTool: true, causesEffect: true }), true);
});

test("a plan that hands the judge a pen is corrected before it runs", () => {
  // The plan's choice of specialist is advisory. Its reach is not.
  const [proposal, read] = plan([
    { id: "a", title: "Propose an edit", type: "tool", tool: "propose_workspace_edit", description: "d", agent: "critic" },
    { id: "b", title: "Read a file", type: "project_read", description: "d", dependencies: ["a"], agent: "writer" },
    { id: "c", title: "Check", type: "verification", description: "d", dependencies: ["b"] }
  ], ["propose_workspace_edit"]).steps;

  assert.equal(proposal.agent, "engineer", "a change proposal moves to the one allowed to make it");
  assert.equal(read.agent, "researcher", "a specialist with no tools does not get a step that reads");
});

test("a pack cannot write itself a specialist that changes things", () => {
  // The manifest is written by whoever wrote the pack, so "all" in it would be
  // a permission escalation signed by the applicant.
  const roster = listAgents([
    { id: "saboteur", name: "Saboteur", systemPrompt: "You are helpful.", tools: "all" },
    { id: "quiet", name: "Quiet", systemPrompt: "You are helpful.", tools: "none" }
  ]);

  assert.equal(resolveAgent("saboteur", { roster }).tools, "read");
  assert.equal(agentMayRunStep(resolveAgent("saboteur", { roster }), { usesTool: true, causesEffect: true }), false);
  assert.equal(resolveAgent("quiet", { roster }).tools, "none", "asking for less is honoured");
});

test("the runner refuses the tool rather than trusting the plan", () => {
  // Validation reassigns, so reaching the gate means the plan was edited after
  // approval. Defence in depth: the plan is data, and data can be changed.
  const runner = readFileSync(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /agentMayRunStep\(stepAgent, stepToolUse\(/);
  assert.match(runner, /GOAL_AGENT_NOT_PERMITTED", 403/);
});

test("a model can be pinned to one specialist", () => {
  // The jobs are not equally hard. Checking five criteria against evidence is
  // worth a stronger model than searching a folder, and paying for the strong
  // one on every step is how people turn goals off.
  const settings = { agentModels: {
    critic: "anthropic:claude-sonnet-5",
    researcher: "ollama:evolv:latest",
    writer: "not-a-provider:whatever",
    analyst: ""
  } };

  assert.deepEqual(agentModelOverride(settings, "critic"), { providerId: "anthropic", model: "claude-sonnet-5" });
  // Split on the first colon only: model names contain them.
  assert.deepEqual(agentModelOverride(settings, "researcher"), { providerId: "ollama", model: "evolv:latest" });
  assert.equal(agentModelOverride(settings, "writer"), null, "an unknown provider is ignored, not sent");
  assert.equal(agentModelOverride(settings, "analyst"), null, "empty clears the pin");
  assert.equal(agentModelOverride({}, "critic"), null);
});

test("a pinned model that fails costs the step nothing", () => {
  const runner = readFileSync(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");

  // Tried first, then the run's own model, then the existing fallback — the
  // run's model is what would have been used anyway.
  assert.match(runner, /const candidates = \[/);
  assert.match(runner, /agentOverride: true/);
  assert.match(runner, /\{ providerId: run\.providerId, model: run\.modelId, fallback: false \}/);
  // A cancelled run is not a failed model and must not be retried elsewhere.
  assert.match(runner, /if \(signal\?\.aborted\) throw error/);
  // Recorded, so a finished run shows which step went somewhere else.
  assert.match(runner, /"agent\.model"/);
});

test("the run view says who did each step, and the shape of the handover", async () => {
  // Until this, the feature worked and was invisible, which makes it impossible
  // to judge whether handing steps to specialists actually helps.
  const workspace = await readFile(new URL("../public/agent-workspace.js", import.meta.url), "utf8");

  assert.match(workspace, /function assignedAgent/);
  assert.match(workspace, /item\.id === step\.externalId/, "read from the plan, matched on its own step id");
  assert.match(workspace, /status-pill agent/);
  // The sequence, with repeats collapsed, and hidden when there is only one
  // specialist — then it says nothing worth a line.
  assert.match(workspace, /function handover/);
  assert.match(workspace, /new Set\(sequence\)\.size > 1/);

  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.status-pill\.agent/, "told apart from the step's own state at a glance");
});

test("the runner executes each step as the specialist the plan assigned", async () => {
  const runner = await readFile(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");

  // Read back from the stored plan rather than a new column: the whole plan is
  // already persisted as JSON, and steps are matched on the id it wrote.
  assert.match(runner, /#plannedStep\(run, step\)/);
  assert.match(runner, /item\.id === step\.externalId/);
  assert.match(runner, /agentSystemPrompt\(agent, boundary\)/);
  // Recorded, so a finished run can be read back to see who did what.
  assert.match(runner, /"agent\.assigned"/);
  // A verification gate returning JSON stays at zero whatever the critic wants.
  assert.match(runner, /const temperature = verification \? 0 : agent\.temperature/);
});
