const TYPES = new Set([
  "text.delta",
  "reasoning.delta",
  "tool.call",
  "provider.state",
  "fallback",
  "usage",
  "finish"
]);

const MAX_DELTA = 1_000_000;

function fail(message) {
  throw Object.assign(new TypeError(message), { code: "INVALID_AI_EVENT" });
}

function boundedText(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${field} must be a string.`);
  if (!allowEmpty && !value) fail(`${field} cannot be empty.`);
  if (value.length > MAX_DELTA) fail(`${field} is too large.`);
  return value;
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

export function normalizeToolArguments(value) {
  if (value == null || value === "") return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function aiEvent(type, fields = {}) {
  if (!TYPES.has(type)) fail(`Unknown AI event type: ${type}`);
  return Object.freeze({ version: 1, type, ...fields });
}

export const textDelta = (delta) => aiEvent("text.delta", { delta: boundedText(delta, "delta") });
export const reasoningDelta = (delta) => aiEvent("reasoning.delta", { delta: boundedText(delta, "delta") });

export function toolCall({ id, name, arguments: args, providerState } = {}) {
  const event = {
    id: boundedText(String(id || ""), "tool call id"),
    name: boundedText(String(name || ""), "tool name"),
    arguments: normalizeToolArguments(args)
  };
  if (providerState != null) event.providerState = record(providerState, "providerState");
  return aiEvent("tool.call", event);
}

export function providerState(provider, state) {
  return aiEvent("provider.state", {
    provider: boundedText(String(provider || ""), "provider"),
    state: record(state, "state")
  });
}

export function fallback(details) {
  return aiEvent("fallback", { details: record(details, "fallback details") });
}

export function usage(details = {}) {
  return aiEvent("usage", { usage: record(details, "usage") });
}

export function finish(reason = "stop") {
  return aiEvent("finish", { reason: boundedText(String(reason || "stop"), "finish reason") });
}

export function assertAiEvent(event) {
  if (!event || event.version !== 1 || !TYPES.has(event.type)) fail("Malformed AI event.");
  if ((event.type === "text.delta" || event.type === "reasoning.delta")) boundedText(event.delta, "delta");
  if (event.type === "tool.call") {
    boundedText(event.id, "tool call id");
    boundedText(event.name, "tool name");
    record(event.arguments, "tool arguments");
  }
  if (event.type === "provider.state") {
    boundedText(event.provider, "provider");
    record(event.state, "state");
  }
  return event;
}

export function collectAiEvent(accumulator, event) {
  assertAiEvent(event);
  if (event.type === "text.delta") accumulator.content += event.delta;
  else if (event.type === "reasoning.delta") accumulator.reasoning += event.delta;
  else if (event.type === "tool.call") accumulator.toolCalls.push(event);
  else if (event.type === "provider.state") accumulator.providerState.push(event.state);
  else if (event.type === "fallback") accumulator.fallbacks.push(event.details);
  else if (event.type === "usage") accumulator.usage = event.usage;
  else if (event.type === "finish") accumulator.finishReason = event.reason;
  return accumulator;
}

export function createAiAccumulator() {
  return { content: "", reasoning: "", toolCalls: [], providerState: [], fallbacks: [], usage: null, finishReason: "" };
}
