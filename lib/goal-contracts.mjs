import { agentMayRunStep, agentRosterPrompt, defaultAgentForStep, resolveAgent } from "./agents.mjs";

const STEP_TYPES = Object.freeze([
  "analyze", "project_search", "project_read", "memory_search", "obsidian_search",
  "obsidian_read", "tool", "verification", "report"
]);

export const GOAL_STEP_TYPES = new Set(STEP_TYPES);

export const GOAL_BUDGET_LIMITS = Object.freeze({
  maxSteps: 12,
  maxRuntimeMs: 20 * 60 * 1000,
  maxToolCalls: 100,
  // More tool calls means more tool output to carry, so the token budget has
  // to move with it or it becomes the new wall.
  maxTokens: 256 * 1024,
  maxRetries: 2,
  maxCostUnits: 10
});

const AUTO_TOOLS = new Set([
  "calculate", "get_datetime", "search_knowledge", "search_memory",
  "list_workspace_files", "read_workspace_text", "search_workspace_text", "inspect_json",
  "list_obsidian_notes", "search_obsidian", "read_obsidian_note", "get_obsidian_backlinks",
  "search_project_knowledge", "list_project_tasks", "convert_units", "text_stats", "hash_text",
  "open_sandbox", "sandbox_write_file", "sandbox_validate",
  "physics_look", "physics_build", "physics_run", "physics_adjust", "physics_connect",
  "encode_text", "decode_text", "generate_uuid", "random_number"
]);

const APPROVAL_TOOLS = new Set([
  "propose_web_research", "propose_workspace_edit", "propose_workspace_create",
  "propose_engineering_check", "propose_obsidian_create", "propose_sandbox_promotion"
]);

function fail(message, code = "GOAL_PLAN_INVALID") {
  throw Object.assign(new Error(message), { status: 400, code });
}

function text(value, maximum, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) fail(`${label} is required and must be ${maximum} characters or fewer.`);
  return normalized;
}

function cleanRecord(value, label = "value") {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000) fail(`${label} is too large.`);
  if (/(^|["'{\s])(\.\.\/|\.\.\\|[a-z]:\\|\\\\)/i.test(serialized)) {
    fail("Plans may use project-relative file names only; direct or escaping paths are not allowed.", "GOAL_PATH_REJECTED");
  }
  return JSON.parse(serialized);
}

export function normalizeGoalBudgets(input = {}) {
  const out = {};
  for (const [key, hardLimit] of Object.entries(GOAL_BUDGET_LIMITS)) {
    const minimum = key === "maxRuntimeMs" ? 30_000 : key === "maxTokens" ? 512 : 0;
    const requested = Number(input[key]);
    out[key] = Number.isFinite(requested) ? Math.max(minimum, Math.min(hardLimit, Math.round(requested))) : hardLimit;
  }
  out.maxSteps = Math.max(1, out.maxSteps);
  return out;
}

function approvalPolicy(step) {
  if (step.type === "tool") {
    if (AUTO_TOOLS.has(step.tool)) return "auto-read";
    if (APPROVAL_TOOLS.has(step.tool)) return "individual-approval";
  }
  if (["project_search", "project_read", "memory_search", "obsidian_search", "obsidian_read", "analyze", "verification", "report"].includes(step.type)) {
    return "auto-read";
  }
  return "individual-approval";
}

// Whether a step reaches a tool at all, and whether that tool can cause
// something rather than only look. The step kinds below run a fixed read tool;
// a `tool` step names its own, and the approval sets already say which of those
// change anything.
const IMPLICIT_TOOL_KINDS = new Set(["project_search", "project_read", "memory_search", "obsidian_search", "obsidian_read"]);

export function stepToolUse({ type, tool }) {
  return {
    usesTool: type === "tool" || IMPLICIT_TOOL_KINDS.has(type),
    causesEffect: type === "tool" && APPROVAL_TOOLS.has(tool)
  };
}

// A specialist that may not reach what the step needs is corrected rather than
// obeyed. The plan's choice is advisory; its reach is not — a plan that put a
// change proposal in the critic's hands would otherwise hand the judge a pen.
function assignAgent(requested, { type, tool }) {
  const use = stepToolUse({ type, tool });
  const chosen = resolveAgent(requested, { step: { type } });
  if (agentMayRunStep(chosen, use)) return chosen.id;
  const fallback = resolveAgent(defaultAgentForStep({ type }), { step: { type } });
  if (agentMayRunStep(fallback, use)) return fallback.id;
  fail(`Step of type “${type}” needs a specialist allowed to run ${tool || "its tool"}.`, "GOAL_AGENT_NOT_PERMITTED");
}

export function validateGoalPlan(input, { availableTools = [], budgets = GOAL_BUDGET_LIMITS } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("The planner did not return a plan object.");
  const summary = text(input.summary || "Goal execution plan", 1000, "Plan summary");
  if (!Array.isArray(input.steps) || input.steps.length < 1) fail("A plan must contain at least one step.");
  // The cap follows the run's own step budget. It used to be hard-coded to 12,
  // which silently overrode any larger budget — raising the tool-call ceiling
  // did nothing, because a plan could never contain enough steps to spend it.
  const limit = Math.max(1, Math.min(GOAL_BUDGET_LIMITS.maxSteps, Number(budgets.maxSteps) || GOAL_BUDGET_LIMITS.maxSteps));
  if (input.steps.length > limit) fail(`The plan exceeds the ${limit}-step budget.`, "GOAL_BUDGET_EXCEEDED");
  const toolNames = new Set(availableTools);
  const ids = new Set();
  const steps = input.steps.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`Step ${index + 1} is malformed.`);
    const id = String(raw.id || `step-${index + 1}`).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || ids.has(id)) fail(`Step ${index + 1} has an invalid or duplicate ID.`);
    ids.add(id);
    const type = String(raw.type || raw.kind || "").trim();
    if (!GOAL_STEP_TYPES.has(type)) fail(`Step ${index + 1} uses unknown type “${type || "missing"}”.`, "GOAL_STEP_TYPE_UNKNOWN");
    const tool = type === "tool" ? String(raw.tool || "").trim() : "";
    if (type === "tool" && (!tool || !toolNames.has(tool))) fail(`Step ${index + 1} uses an unavailable tool.`, "GOAL_TOOL_UNKNOWN");
    const dependencies = Array.isArray(raw.dependencies) ? [...new Set(raw.dependencies.map(String))] : (index ? [input.steps[index - 1]?.id || `step-${index}`] : []);
    return {
      id,
      title: text(raw.title || `Step ${index + 1}`, 200, `Step ${index + 1} title`),
      description: text(raw.description || raw.title || `Complete step ${index + 1}`, 2000, `Step ${index + 1} description`),
      type,
      tool,
      dependencies,
      inputs: cleanRecord(raw.inputs, `Step ${index + 1} inputs`),
      expectedEvidence: String(raw.expectedEvidence || "Recorded result").slice(0, 1000),
      verificationCriteria: String(raw.verificationCriteria || (type === "verification" ? "Compare all evidence with the original success criteria." : "Step output is recorded without an unresolved error.")).slice(0, 1500),
      approvalPolicy: approvalPolicy({ type, tool }),
      // Which specialist executes this step. Always resolved to a real one, so
      // a plan that names nobody — or names somebody who does not exist — still
      // gets the right voice for its step type rather than failing validation.
      agent: assignAgent(raw.agent, { type, tool })
    };
  });
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    for (const dependency of step.dependencies) if (!byId.has(dependency)) fail(`Step “${step.id}” has an unknown dependency.`);
    if (step.dependencies.includes(step.id)) fail(`Step “${step.id}” cannot depend on itself.`, "GOAL_DEPENDENCY_CYCLE");
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail("The plan contains a dependency cycle.", "GOAL_DEPENDENCY_CYCLE");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const step of steps) visit(step.id);
  if (!steps.some((step) => step.type === "verification")) fail("Every goal plan must end with an explicit verification step.", "GOAL_VERIFICATION_REQUIRED");
  const lastVerification = steps.map((step) => step.type).lastIndexOf("verification");
  if (lastVerification !== steps.length - 1 && steps.at(-1).type !== "report") fail("Verification must be the final step, or be followed only by a report.");
  return { summary, steps };
}

export function plannerSystemPrompt(toolNames = []) {
  return `You are Evolv's bounded goal planner. Return JSON only with {"summary":"...","steps":[...]}. Use 1-12 ordered steps. Every step needs id, title, description, type, dependencies, inputs, expectedEvidence, and verificationCriteria. Allowed types: ${STEP_TYPES.join(", ")}. A tool step also needs tool. Available tools: ${toolNames.join(", ") || "none"}. Each step may also name the specialist that should carry it out as "agent", one of: ${agentRosterPrompt()}. Omit it and a suitable one is chosen from the step type. End with a verification step (a report may follow). Use only project-relative paths. Never invent tools, commands, URLs, credentials, permission changes, package installs, or destructive actions. Network research and all changes must use the available proposal tools and will require approval.`;
}

// Models that are perfectly capable of planning still wrap their answer: a
// sentence of preamble, a fenced block mid-message, or a reasoning trace that
// leaks into content rather than arriving on the thinking channel. Rejecting
// those is a parser limitation, not a model failure, so recover the object
// instead. This stays strict about the result — whatever is extracted still
// has to satisfy validateGoalPlan.
function withoutReasoningTrace(value) {
  return String(value || "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    // An unterminated trace means the model never closed the tag; everything
    // after it is reasoning, so there is no JSON to find before it either.
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ");
}

function fencedBlocks(value) {
  const blocks = [];
  const fence = /```(?:json5?|jsonc)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = fence.exec(value)) && blocks.length < 10) blocks.push(match[1].trim());
  return blocks;
}

// Scans for top-level {...} or [...] runs, skipping over string literals so a
// brace inside a description cannot end the object early.
function balancedSpans(value) {
  const spans = [];
  for (let index = 0; index < value.length && spans.length < 10; index += 1) {
    const open = value[index];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < value.length; cursor += 1) {
      const character = value[cursor];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = inString; continue; }
      if (character === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (character === open) depth += 1;
      else if (character === close && (depth -= 1) === 0) {
        spans.push(value.slice(index, cursor + 1));
        index = cursor;
        break;
      }
    }
  }
  return spans;
}

export function parsePlannerJson(content) {
  const cleaned = withoutReasoningTrace(content);
  // Most explicit first: an author-marked block, then the whole message, then
  // any balanced object embedded in prose.
  for (const candidate of [...fencedBlocks(cleaned), cleaned.trim(), ...balancedSpans(cleaned)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* try the next candidate */ }
  }
  fail("The planning model returned malformed JSON.", "GOAL_PLANNER_MALFORMED");
}
