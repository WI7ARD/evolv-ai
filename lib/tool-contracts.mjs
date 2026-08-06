export const TOOL_CONTRACT_VERSION = 1;

export const TOOL_RISK_POLICIES = Object.freeze({
  read: Object.freeze({ id: "read", automatic: true, approval: "none", effect: "local-read", enabled: true }),
  "network-read": Object.freeze({ id: "network-read", automatic: true, approval: "none", effect: "bounded-network-read", enabled: true }),
  // Writes that land only inside a disposable sandbox. Automatic on purpose:
  // the point of simulating is that a model can try, fail, and retry without
  // asking. The approval belongs to promoting the result, not to the attempt.
  sandbox: Object.freeze({ id: "sandbox", automatic: true, approval: "none", effect: "sandbox-write", enabled: true }),
  "approval-write": Object.freeze({ id: "approval-write", automatic: false, approval: "per-effect", effect: "proposal-only", enabled: true }),
  "sensitive-write": Object.freeze({ id: "sensitive-write", automatic: false, approval: "per-effect", effect: "write", enabled: false }),
  command: Object.freeze({ id: "command", automatic: false, approval: "per-effect", effect: "command", enabled: false }),
  destructive: Object.freeze({ id: "destructive", automatic: false, approval: "per-effect", effect: "destructive", enabled: false })
});

export const GENERIC_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: ["object", "array", "string", "number", "boolean", "null"],
  description: "A bounded JSON-serializable tool result."
});

function contractError(message) {
  return Object.assign(new Error(message), { code: "TOOL_CONTRACT_INVALID" });
}

export function defineToolContract(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw contractError("Tool definition must be an object.");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(String(definition.name || ""))) throw contractError("Tool name is invalid.");
  if (!String(definition.description || "").trim()) throw contractError(`Tool ${definition.name} needs a description.`);
  const policy = TOOL_RISK_POLICIES[definition.risk];
  if (!policy) throw contractError(`Tool ${definition.name} has an unknown risk class.`);
  if (!policy.enabled) throw contractError(`Tool ${definition.name} uses a disabled risk class.`);
  if (!definition.schema || definition.schema.type !== "object") throw contractError(`Tool ${definition.name} needs an object input schema.`);
  if (typeof definition.validate !== "function" || typeof definition.execute !== "function") {
    throw contractError(`Tool ${definition.name} needs validation and execution handlers.`);
  }
  const timeoutMs = Math.max(100, Math.min(300_000, Math.round(Number(definition.timeoutMs) || 15_000)));
  return Object.freeze({
    ...definition,
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: definition.schema,
    outputSchema: definition.outputSchema || GENERIC_TOOL_OUTPUT_SCHEMA,
    riskPolicy: policy,
    timeoutMs
  });
}

export function createToolSignal(timeoutMs, upstreamSignal = null) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = upstreamSignal ? AbortSignal.any([upstreamSignal, timeoutSignal]) : timeoutSignal;
  return { signal, timeoutSignal };
}

export function throwIfToolAborted(signal) {
  if (!signal?.aborted) return;
  const timeout = signal.reason?.name === "TimeoutError";
  throw Object.assign(new Error(timeout ? "Tool timed out." : "Tool execution was cancelled."), {
    name: timeout ? "TimeoutError" : "AbortError",
    code: timeout ? "TIMEOUT" : "CANCELLED"
  });
}

export function dryRunToolContract(contract, args, { enabled = true, policyAllowed = true } = {}) {
  if (!enabled) return { ok: false, executable: false, code: "TOOL_DISABLED", error: "Tool is disabled." };
  if (!policyAllowed) return { ok: false, executable: false, code: "POLICY_DENIED", error: "Tool permission is not granted." };
  try { contract.validate(args); }
  catch (error) {
    return { ok: false, executable: false, code: error.code || "INVALID_ARGUMENT", error: error.message };
  }
  return {
    ok: true,
    executable: contract.riskPolicy.automatic,
    contractVersion: contract.contractVersion,
    tool: contract.name,
    risk: contract.risk,
    permission: contract.permission || null,
    approval: contract.riskPolicy.approval,
    effect: contract.riskPolicy.effect,
    timeoutMs: contract.timeoutMs,
    input: args,
    note: contract.risk === "approval-write"
      ? "Execution may create a reviewable proposal only; applying its effect still requires approval."
      : "Dry run validated the request. No tool handler was executed."
  };
}
