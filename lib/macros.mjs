// Composite tool ("macro") support: mining repeated tool sequences out of the
// audit log, validating user-approved macro definitions, and executing them by
// chaining the existing read-only tools. Suggestions are display-only; a macro
// becomes callable only after the user explicitly approves a definition.

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_STEPS = 8;
const MAX_INPUTS = 6;

function macroError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Counts consecutive tool-name n-grams (length 2..maxLength) within each
// conversation. A sequence repeated across enough conversations is a
// candidate composite tool.
export function mineToolSequences(runs, { minCount = 3, maxLength = 3 } = {}) {
  const byConversation = new Map();
  for (const run of runs) {
    if (!run.conversationId || run.status !== "completed") continue;
    if (!byConversation.has(run.conversationId)) byConversation.set(run.conversationId, []);
    byConversation.get(run.conversationId).push(run);
  }
  const counts = new Map();
  for (const group of byConversation.values()) {
    group.sort((left, right) => (left.createdAt || "").localeCompare(right.createdAt || ""));
    const names = group.map((run) => run.toolName);
    const seenInConversation = new Set();
    for (let length = 2; length <= maxLength; length += 1) {
      for (let start = 0; start + length <= names.length; start += 1) {
        const tools = names.slice(start, start + length);
        if (new Set(tools).size === 1) continue; // repeats of one tool are retries, not a pipeline
        const key = tools.join("+");
        const entry = counts.get(key) || { tools, count: 0, conversations: 0 };
        entry.count += 1;
        if (!seenInConversation.has(key)) {
          entry.conversations += 1;
          seenInConversation.add(key);
        }
        counts.set(key, entry);
      }
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= minCount)
    .sort((left, right) => right.count - left.count || right.conversations - left.conversations)
    .slice(0, 10)
    .map((entry) => ({
      ...entry,
      key: entry.tools.join("+"),
      suggestedName: entry.tools.join("_and_").slice(0, 41).replace(/_+$/, "").replace(/^_+/, ""),
      title: entry.tools.join(" → "),
      description: `Runs ${entry.tools.join(", then ")} as one step. Observed ${entry.count} times across ${entry.conversations} conversation(s).`
    }));
}

function resolveReference(reference, context) {
  const segments = reference.trim().split(".");
  if (!["input", "steps"].includes(segments[0])) {
    throw macroError(`Template reference must start with "input" or "steps": {{${reference}}}`);
  }
  let value = context;
  for (const segment of segments) {
    if (UNSAFE_SEGMENTS.has(segment) || !(IDENTIFIER_PATTERN.test(segment) || /^\d+$/.test(segment))) {
      throw macroError(`Unsafe template reference: {{${reference}}}`);
    }
    value = value?.[segment];
  }
  if (value === undefined) throw macroError(`Template reference resolved to nothing: {{${reference}}}`);
  return value;
}

// Resolves {{input.x}} / {{steps.0.output.y}} placeholders inside a step's
// argument template. A string that is exactly one placeholder keeps the raw
// value; placeholders embedded in longer strings are stringified.
export function resolveArgTemplate(template, context) {
  if (typeof template === "string") {
    const whole = template.match(/^\{\{([^{}]+)\}\}$/);
    if (whole) return resolveReference(whole[1], context);
    return template.replace(/\{\{([^{}]+)\}\}/g, (_match, reference) => {
      const value = resolveReference(reference, context);
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => resolveArgTemplate(item, context));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveArgTemplate(value, context)]));
  }
  return template;
}

function collectReferences(template, found = []) {
  if (typeof template === "string") {
    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) found.push(match[1].trim());
  } else if (Array.isArray(template)) {
    for (const item of template) collectReferences(item, found);
  } else if (template && typeof template === "object") {
    for (const value of Object.values(template)) collectReferences(value, found);
  }
  return found;
}

export function validateMacroDefinition(definition, builtinToolNames) {
  const name = String(definition?.name || "").trim();
  const title = String(definition?.title || "").trim();
  const description = String(definition?.description || "").trim();
  if (!NAME_PATTERN.test(name)) throw macroError("Macro name must be 3–41 characters of lowercase letters, digits, and underscores.");
  if (title.length < 2) throw macroError("Macro title is required.");
  const inputs = (Array.isArray(definition?.inputs) ? definition.inputs : []).slice(0, MAX_INPUTS).map((input) => {
    const inputName = String(input?.name || "").trim();
    if (!IDENTIFIER_PATTERN.test(inputName)) throw macroError(`Invalid macro input name: ${inputName || "(empty)"}`);
    return {
      name: inputName,
      description: String(input?.description || "").slice(0, 300),
      required: input?.required !== false
    };
  });
  const inputNames = new Set(inputs.map((input) => input.name));
  if (inputNames.size !== inputs.length) throw macroError("Macro input names must be unique.");
  const steps = Array.isArray(definition?.steps) ? definition.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw macroError(`A macro needs 1–${MAX_STEPS} steps.`);
  const normalizedSteps = steps.map((step, index) => {
    const tool = String(step?.tool || "").trim();
    if (!builtinToolNames.has(tool)) throw macroError(`Step ${index + 1} uses an unknown tool: ${tool || "(empty)"}. Macros may only chain built-in tools.`);
    const args = step?.args == null ? {} : step.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw macroError(`Step ${index + 1} arguments must be an object.`);
    for (const reference of collectReferences(args)) {
      const segments = reference.split(".");
      if (segments[0] === "input") {
        if (!inputNames.has(segments[1])) throw macroError(`Step ${index + 1} references unknown input {{${reference}}}.`);
      } else if (segments[0] === "steps") {
        const stepIndex = Number(segments[1]);
        if (!Number.isInteger(stepIndex) || stepIndex >= index) {
          throw macroError(`Step ${index + 1} may only reference outputs of earlier steps: {{${reference}}}.`);
        }
      } else {
        throw macroError(`Step ${index + 1} has an invalid reference {{${reference}}}. Use input.* or steps.N.output.*.`);
      }
    }
    return { tool, args };
  });
  return { name, title, description, steps: normalizedSteps, inputs };
}

export function macroSchema(macro) {
  return {
    type: "object",
    required: macro.inputs.filter((input) => input.required).map((input) => input.name),
    properties: Object.fromEntries(macro.inputs.map((input) => [
      input.name,
      { type: "string", description: input.description || `Value for ${input.name}.` }
    ]))
  };
}

// Runs each step through the ordinary tool executor (so every inner call is
// still validated, time-limited, and audited) and threads outputs forward.
export async function executeMacro({ macro, args, executeTool, signal = null }) {
  const context = { input: args || {}, steps: [] };
  const results = [];
  for (const [index, step] of macro.steps.entries()) {
    signal?.throwIfAborted();
    let resolvedArgs;
    try {
      resolvedArgs = resolveArgTemplate(step.args, context);
    } catch (error) {
      return { ok: false, steps: results, error: `Step ${index + 1} (${step.tool}): ${error.message}` };
    }
    const result = await executeTool(step.tool, resolvedArgs);
    signal?.throwIfAborted();
    let output = result.output;
    try {
      output = JSON.parse(result.output);
    } catch { /* tool output was truncated or plain text; keep the raw string */ }
    results.push({
      tool: step.tool,
      ok: result.ok,
      output,
      pendingApproval: Boolean(result.pendingApproval),
      runId: result.runId || null
    });
    if (!result.ok) {
      return { ok: false, steps: results, error: `Step ${index + 1} (${step.tool}) failed.` };
    }
    context.steps.push({ tool: step.tool, ok: result.ok, output });
    // A write-capable inner tool only creates a proposal. Stop the recipe here
    // so later steps cannot run until the user reviews that exact diff.
    if (result.pendingApproval) {
      return {
        ok: true,
        pendingApproval: true,
        pendingStep: index,
        innerRunId: result.runId || null,
        steps: results
      };
    }
  }
  return { ok: true, steps: results };
}
