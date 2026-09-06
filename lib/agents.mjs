// The specialists a goal plan can be shared out between.
//
// Every step of every goal ran with one voice: "you are executing one approved
// step in Evolv's bounded goal runner". That is the right instruction for none
// of them in particular. Checking a claim against evidence and writing the final
// report are different jobs, and a model told which one it is doing does it
// noticeably better than a model told nothing.
//
// This is deliberately not an agent framework. There is no message passing, no
// negotiation, and no agent that can start another — Evolv already has a runtime
// with plans, dependencies, leases, budgets and approvals, and all of that
// applies unchanged. An agent here is a role a step is executed as: a voice, a
// temperature, and optionally a narrower set of tools than the step could
// otherwise reach.

export const BUILT_IN_AGENTS = Object.freeze([
  {
    id: "researcher",
    name: "Researcher",
    description: "Gathers evidence and records where each fact came from.",
    systemPrompt: "You are the researcher on this goal. Collect what the step asks for and record it plainly. "
      + "Every claim you make must be traceable to something in the provided evidence — quote it rather than paraphrasing when the wording matters. "
      + "Say what you could not find as clearly as what you did.",
    temperature: 0.2,
    tools: "read"
  },
  {
    id: "engineer",
    name: "Engineer",
    description: "Reads code and files, and proposes precise changes.",
    systemPrompt: "You are the engineer on this goal. Work from what the files actually contain, not from what a project of this kind usually contains. "
      + "Name files and symbols exactly. When you propose a change, say what breaks if it is wrong.",
    temperature: 0.15,
    // The only specialist that may propose a change, and every proposal still
    // stops for approval before anything happens.
    tools: "all"
  },
  {
    id: "analyst",
    name: "Analyst",
    description: "Reasons over collected evidence and quantifies the answer.",
    systemPrompt: "You are the analyst on this goal. Reason over the evidence already gathered rather than seeking more. "
      + "Show the steps that lead to any number you give, and state the assumptions that number depends on.",
    temperature: 0.25,
    tools: "none"
  },
  {
    id: "critic",
    name: "Critic",
    description: "Checks the work against the criteria and looks for what is missing.",
    systemPrompt: "You are the critic on this goal. Your job is to find where the evidence does not support the claim. "
      + "Compare what was recorded against the original success criteria, one criterion at a time. "
      + "A criterion with no evidence behind it is unmet, however reasonable the answer sounds. Say so.",
    temperature: 0.1,
    // Read what was recorded, change nothing. A judge that can alter the thing
    // it is judging is not a judge.
    tools: "read"
  },
  {
    id: "writer",
    name: "Writer",
    description: "Turns the recorded evidence into something a person can read.",
    systemPrompt: "You are writing the final account of this goal for someone who was not watching it run. "
      + "Lead with what was achieved and what was not. Keep every figure traceable to the evidence, and do not introduce anything the run did not record.",
    temperature: 0.3,
    tools: "none"
  }
]);

// Which specialist a step goes to when the plan does not say. A plan that names
// nobody still gets the right voice per step, which is what makes this work for
// plans written before agents existed.
// The control condition. Specialists were built on a claim — that a model told
// which job it is doing does that job better — and until a run exists that was
// carried out without them, the claim is untested. This is what the runner did
// before specialists: one voice for every step, the bounded-runner boundary and
// nothing after it, no per-role temperature, no per-role reach, no per-role
// model. Turning specialists off has to produce exactly that and not some third
// thing, or the comparison measures the wrong difference.
export const GENERALIST_AGENT = Object.freeze({
  id: "generalist",
  name: "Generalist",
  description: "Carries out every step with no role-specific instruction.",
  systemPrompt: "",
  temperature: 0.2,
  // Reach is left to the runner's own gate, which is where it lived before
  // specialists existed. This grants nothing: every proposal still stops for
  // approval and the plan still only contains tools the runner offered.
  tools: "all"
});

const BY_STEP_TYPE = Object.freeze({
  project_search: "researcher",
  project_read: "researcher",
  memory_search: "researcher",
  obsidian_search: "researcher",
  obsidian_read: "researcher",
  tool: "engineer",
  analyze: "analyst",
  verification: "critic",
  report: "writer"
});

export function listAgents(extra = []) {
  // Pack-provided agents extend the roster; a pack cannot replace a built-in,
  // because a goal that silently changed voice on install would be worse than
  // one that ignored the pack.
  const seen = new Set(BUILT_IN_AGENTS.map((agent) => agent.id));
  const additional = (Array.isArray(extra) ? extra : [])
    .filter((agent) => agent?.id && !seen.has(agent.id) && typeof agent.systemPrompt === "string")
    .map((agent) => ({
      id: String(agent.id),
      name: String(agent.name || agent.id),
      description: String(agent.description || ""),
      systemPrompt: String(agent.systemPrompt).slice(0, 4000),
      temperature: Number.isFinite(Number(agent.temperature)) ? Number(agent.temperature) : 0.25,
      // A pack cannot grant its own specialist more reach than reading. Asking
      // for "all" in a manifest would be a permission escalation written by
      // whoever wrote the pack.
      tools: agent.tools === "none" ? "none" : "read"
    }));
  return [...BUILT_IN_AGENTS, ...additional];
}

export function defaultAgentForStep(step = {}) {
  return BY_STEP_TYPE[String(step.type || "")] || "analyst";
}

// An unknown name falls back rather than failing the plan. The planner is a
// model, the roster is advisory, and rejecting an otherwise valid plan over a
// misremembered role would cost more than quietly using the right default.
export function resolveAgent(id, { step = {}, roster = BUILT_IN_AGENTS } = {}) {
  const wanted = String(id || "").trim().toLowerCase();
  return roster.find((agent) => agent.id === wanted)
    || roster.find((agent) => agent.id === defaultAgentForStep(step))
    || roster[0];
}

// What a specialist is allowed to reach, as opposed to what it is asked to do.
// A prompt telling the critic not to change anything is a request; this is the
// answer to "may it". Three policies, because the distinction that matters is
// whether a step reads or causes something:
//
//   all    reads, sandbox work, and change proposals — every proposal still
//          stops for approval, so this widens nothing the runner already allows
//   read   tools that only look
//   none   no tools at all; reasons over what other steps recorded
//
// A step that runs no tool is open to everyone: there is nothing to gate.
export function agentMayRunStep(agent, { usesTool = false, causesEffect = false } = {}) {
  if (!usesTool) return true;
  const policy = agent?.tools || "read";
  if (policy === "all") return true;
  if (policy === "none") return false;
  return !causesEffect;
}

const PROVIDERS = new Set(["ollama", "openai"]);

// A model pinned to one specialist, written "provider:model" in settings.
//
// The point is that the jobs are not equally hard. Checking five criteria
// against recorded evidence is worth a stronger model than searching a folder,
// and paying for the strong one on every step of every goal is how people end
// up turning goals off. A run still has one model of its own; this is an
// exception per role, not a second router.
//
// Split on the first colon only: model names contain them — evolv:latest.
export function agentModelOverride(settings = {}, agentId = "") {
  const value = String(settings.agentModels?.[agentId] || "").trim();
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const providerId = value.slice(0, separator);
  const model = value.slice(separator + 1).trim();
  return PROVIDERS.has(providerId) && model ? { providerId, model } : null;
}

// The bounded-runner rules come first and are not the agent's to soften: the
// role describes how to do the step, not what the runner is allowed to do.
export function agentSystemPrompt(agent, boundary) {
  // An agent with nothing to add leaves the boundary exactly as it was, rather
  // than trailing it with blank lines. The control condition depends on this:
  // its prompt has to be byte-for-byte what the runner sent before specialists.
  const role = String(agent?.systemPrompt || "").trim();
  return role ? `${boundary}\n\n${role}` : boundary;
}

export function agentRosterPrompt(roster = BUILT_IN_AGENTS) {
  return roster.map((agent) => `${agent.id} (${agent.description})`).join("; ");
}
