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
    temperature: 0.2
  },
  {
    id: "engineer",
    name: "Engineer",
    description: "Reads code and files, and proposes precise changes.",
    systemPrompt: "You are the engineer on this goal. Work from what the files actually contain, not from what a project of this kind usually contains. "
      + "Name files and symbols exactly. When you propose a change, say what breaks if it is wrong.",
    temperature: 0.15
  },
  {
    id: "analyst",
    name: "Analyst",
    description: "Reasons over collected evidence and quantifies the answer.",
    systemPrompt: "You are the analyst on this goal. Reason over the evidence already gathered rather than seeking more. "
      + "Show the steps that lead to any number you give, and state the assumptions that number depends on.",
    temperature: 0.25
  },
  {
    id: "critic",
    name: "Critic",
    description: "Checks the work against the criteria and looks for what is missing.",
    systemPrompt: "You are the critic on this goal. Your job is to find where the evidence does not support the claim. "
      + "Compare what was recorded against the original success criteria, one criterion at a time. "
      + "A criterion with no evidence behind it is unmet, however reasonable the answer sounds. Say so.",
    temperature: 0.1
  },
  {
    id: "writer",
    name: "Writer",
    description: "Turns the recorded evidence into something a person can read.",
    systemPrompt: "You are writing the final account of this goal for someone who was not watching it run. "
      + "Lead with what was achieved and what was not. Keep every figure traceable to the evidence, and do not introduce anything the run did not record.",
    temperature: 0.3
  }
]);

// Which specialist a step goes to when the plan does not say. A plan that names
// nobody still gets the right voice per step, which is what makes this work for
// plans written before agents existed.
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
      temperature: Number.isFinite(Number(agent.temperature)) ? Number(agent.temperature) : 0.25
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

// The bounded-runner rules come first and are not the agent's to soften: the
// role describes how to do the step, not what the runner is allowed to do.
export function agentSystemPrompt(agent, boundary) {
  return `${boundary}\n\n${agent.systemPrompt}`;
}

export function agentRosterPrompt(roster = BUILT_IN_AGENTS) {
  return roster.map((agent) => `${agent.id} (${agent.description})`).join("; ");
}
