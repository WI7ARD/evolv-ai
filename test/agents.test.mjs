import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  BUILT_IN_AGENTS, agentMayRunStep, agentModelOverride, agentRosterPrompt, agentSystemPrompt,
  defaultAgentForStep, listAgents, resolveAgent, GENERALIST_AGENT
} from "../lib/agents.mjs";
import { plannerSystemPrompt, validateGoalPlan } from "../lib/goal-contracts.mjs";
import { DEFAULT_INTELLIGENCE_SETTINGS, normalizeIntelligenceSettings } from "../lib/intelligence.mjs";

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

test("a pack's specialist can be given a step, and keeps its voice", () => {
  // Until now a pack could ship a specialist that nothing could ever assign:
  // plans were always validated against the built-in roster, so the name was
  // corrected away before the plan was stored.
  const roster = listAgents([{
    id: "acme.legal:contracts", name: "Contract Reader", description: "Reads contracts.",
    systemPrompt: "You are the contracts specialist.", temperature: 0.1
  }]);

  const [step] = validateGoalPlan({
    summary: "s",
    steps: [
      { id: "a", title: "Read the terms", type: "project_read", description: "d", agent: "acme.legal:contracts" },
      { id: "b", title: "Check", type: "verification", description: "d", dependencies: ["a"] }
    ]
  }, { availableTools: [], roster }).steps;

  assert.equal(step.agent, "acme.legal:contracts");
  assert.equal(resolveAgent(step.agent, { roster }).systemPrompt, "You are the contracts specialist.");
});

test("a pack specialist is offered to the planner and bounded like any other", () => {
  const roster = listAgents([{
    id: "acme.legal:contracts", name: "Contract Reader", description: "Reads contracts.",
    systemPrompt: "You are the contracts specialist.", tools: "all"
  }]);

  // Named in the prompt, so the planner can actually choose it.
  assert.match(plannerSystemPrompt(["read_workspace_text"], roster), /acme\.legal:contracts \(Reads contracts\.\)/);

  // And still capped at reading, so a pack cannot write itself a specialist
  // that proposes changes.
  const [step] = validateGoalPlan({
    summary: "s",
    steps: [
      { id: "a", title: "Edit", type: "tool", tool: "propose_workspace_edit", description: "d", agent: "acme.legal:contracts" },
      { id: "b", title: "Check", type: "verification", description: "d", dependencies: ["a"] }
    ]
  }, { availableTools: ["propose_workspace_edit"], roster }).steps;
  assert.equal(step.agent, "engineer", "a change proposal moves to the one allowed to make it");
});

test("a plan validated without the pack falls back rather than failing", () => {
  // The same plan, revised while the pack is disabled or uninstalled. Rejecting
  // it would strand the run; the step is simply carried out by the default for
  // its type.
  const [step] = validateGoalPlan({
    summary: "s",
    steps: [
      { id: "a", title: "Read the terms", type: "project_read", description: "d", agent: "acme.legal:contracts" },
      { id: "b", title: "Check", type: "verification", description: "d", dependencies: ["a"] }
    ]
  }, { availableTools: [] }).steps;

  assert.equal(step.agent, "researcher");
});

test("only the run's own pack lends its specialists", async () => {
  // A pack installed for something else has no business putting a voice into
  // every goal on the machine.
  const runner = readFileSync(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");

  assert.match(runner, /#roster\(packId = "", specialists = true\)/);
  assert.match(runner, /item\.type === "agent" && item\.packId === packId/);
  assert.match(runner, /if \(!packId \|\| typeof this\.marketplace\?\.runtime !== "function"\) return listAgents\(\)/);
  // Every place a plan is written, revised, or executed resolves against the
  // same roster, or a specialist would survive planning and vanish at run time.
  assert.match(runner, /plannerSystemPrompt\(tools, roster\)/);
  assert.match(runner, /roster: this\.#roster\(packId, specialists\)/);
  assert.match(runner, /roster: this\.#roster\(current\.goal\?\.packId, this\.#specialists\(current\)\)/);
  assert.match(runner, /roster: this\.#roster\(run\.goal\?\.packId, specialists\)/);
});

test("the roster is settable in the interface, from the server's own list", async () => {
  // The pins were reachable only by PATCHing settings by hand, which is a
  // feature that exists and cannot be used.
  const [html, app, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="agent-model-pins"/);
  assert.match(html, /id="save-agent-models"/);

  // Read from the server rather than listed again in the client, or there
  // would be two copies of who the specialists are.
  assert.match(server, /url\.pathname === "\/api\/agents"/);
  assert.match(app, /api\("\/api\/agents"\)/);
  assert.doesNotMatch(app, /BUILT_IN_AGENTS/, "the client never carries its own roster");

  // A pin set against another provider must survive the chat provider changing.
  assert.match(app, /if \(agent\.model && !options\.includes\(agent\.model\)\) options\.unshift\(agent\.model\)/);
  // Clearing a pin has to be a change, not an omission.
  assert.match(app, /\$\$\("\[data-agent-model\]"\)/);
  // What each specialist may reach, in words rather than a policy name.
  assert.match(app, /reasons over what other steps found/);
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

// The control arm. Specialists rest on a claim — that a model told which job it
// is doing does that job better — and until goals have run without them the
// claim is untested. Turning them off has to reproduce the runner as it was,
// not invent a third behaviour, or the comparison measures the wrong thing.

test("the generalist reproduces the runner as it was before specialists", () => {
  const boundary = "You are executing one approved step in Evolv's bounded goal runner.";

  // Byte for byte the old prompt. A trailing blank line would be a difference
  // between the arms that nobody chose.
  assert.equal(agentSystemPrompt(GENERALIST_AGENT, boundary), boundary);
  // And still first when a role does have something to say.
  assert.ok(agentSystemPrompt(resolveAgent("critic"), boundary).startsWith(`${boundary}\n\n`));

  // Reach is left to the runner's own gate, which is where it lived before.
  assert.equal(agentMayRunStep(GENERALIST_AGENT, { usesTool: true, causesEffect: true }), true);
});

test("with specialists off there is one voice, whatever the plan or the pack asks for", () => {
  const roster = [GENERALIST_AGENT];

  // Every step, every named role, every pack agent: the same one.
  for (const type of ["project_read", "tool", "analyze", "verification", "report"]) {
    assert.equal(resolveAgent(undefined, { step: { type }, roster }).id, "generalist");
  }
  assert.equal(resolveAgent("critic", { roster }).id, "generalist");
  assert.equal(resolveAgent("acme.legal:contracts", { roster }).id, "generalist");

  // And the planner is not offered a roster it cannot use.
  const prompt = plannerSystemPrompt(["list_workspace_files"], roster);
  assert.match(prompt, /generalist/);
  assert.doesNotMatch(prompt, /critic/);
});

test("the arm a run started in is fixed on the run, not re-read from settings", async () => {
  const runner = await readFile(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");

  // Decided once, at creation, and written into the run's request. A setting
  // flipped halfway through a goal must not change what that goal was.
  assert.match(runner, /const specialists = this\.#specialists\(\);/);
  assert.match(runner, /fallback: proposed\.route\.fallback, specialists \}/);
  assert.match(runner, /if \(typeof run\?\.request\?\.specialists === "boolean"\) return run\.request\.specialists;/);

  // A pinned model is part of what specialists buy you. Letting one through in
  // the control arm would put the two arms on different models, and the
  // comparison would be measuring that instead.
  assert.match(runner, /specialists \? agentModelOverride\(this\.database\.getSettings\(\), agent\.id\) : null/);
});

test("turning specialists off is a setting a run can be recorded against", () => {
  assert.equal(DEFAULT_INTELLIGENCE_SETTINGS.agentSpecialists, true, "on unless asked otherwise");
  assert.equal(normalizeIntelligenceSettings({}).agentSpecialists, true);
  assert.equal(normalizeIntelligenceSettings({ agentSpecialists: false }).agentSpecialists, false);
  // Anything that is not an explicit false leaves specialists on, so a garbled
  // settings file cannot silently move every goal into the control arm.
  assert.equal(normalizeIntelligenceSettings({ agentSpecialists: "no" }).agentSpecialists, true);
});

test("the comparison is reachable and readable without editing settings by hand", async () => {
  const [html, app, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="agent-specialists-enabled"/);
  assert.match(html, /id="specialist-cohorts"/);
  assert.match(server, /url\.pathname === "\/api\/evolution\/specialists"/);
  assert.match(app, /api\("\/api\/evolution\/specialists"\)/);

  // The switch saves itself. The button beside it says "save specialist
  // models", and whether specialists run at all is not one of those.
  assert.match(app, /\$\("#agent-specialists-enabled"\)\?\.addEventListener\("change"/);
  assert.match(app, /agentSpecialists: enabled/);

  // The verdict is the server's, printed as written. A client that phrased its
  // own conclusion could reach a different one from the same numbers.
  assert.match(app, /\$\("#specialist-verdict"\)\.textContent = report\.verdict/);
  // z-scores are withheld until both arms clear the floor, or the page would
  // invite exactly the conclusion the verdict is refusing to draw.
  assert.match(app, /report\.cohorts\.control\.runs >= report\.minimumCohort/);
});
