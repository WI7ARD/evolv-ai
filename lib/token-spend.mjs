// What a turn actually cost, from what the provider said it used.
//
// Evolv used to estimate tokens as `characters / 4` and charge "one cost unit"
// per cloud request. Both are fictions, and the second is the more misleading:
// it counts a two-line question and a forty-tool agent run the same, so a
// monthly limit built on it caps nothing anyone cares about.
//
// The real figures were already arriving — OpenAI reports usage on the final
// stream event, Ollama reports its own counts — and were being dropped on the
// floor. This turns them into a number of tokens, and then into a rough
// estimate of money.
//
// ON THE MONEY BEING AN ESTIMATE
//
// This is not a bill and must never be shown as one. Evolv has no access to
// what OpenAI actually charges an account: the published rates change, they
// vary by tier, and discounts, batch pricing and free allowances are invisible
// from here. The rates below are the public list prices at the date named, kept
// in one table so they can be corrected in one edit, and every figure derived
// from them is labelled "estimated" wherever it is shown. The token counts, by
// contrast, are the provider's own and are exact.

// Public list prices in US dollars per million tokens, as published on
// 2026-08-19. Cached input is billed at a discount by OpenAI and is tracked
// separately because on a tool loop — where the same system prompt and tool
// schemas are re-sent every round — it is most of the input.
//
// Matched longest-prefix-first, so "gpt-5-mini" is not read as "gpt-5".
export const PRICES_UPDATED = "2026-08-19";
const RATES = [
  ["gpt-5-nano", { input: 0.05, cachedInput: 0.005, output: 0.40 }],
  ["gpt-5-mini", { input: 0.25, cachedInput: 0.025, output: 2.00 }],
  ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10.00 }],
  ["gpt-4.1-nano", { input: 0.10, cachedInput: 0.025, output: 0.40 }],
  ["gpt-4.1-mini", { input: 0.40, cachedInput: 0.10, output: 1.60 }],
  ["gpt-4.1", { input: 2.00, cachedInput: 0.50, output: 8.00 }],
  ["gpt-4o-mini", { input: 0.15, cachedInput: 0.075, output: 0.60 }],
  ["gpt-4o", { input: 2.50, cachedInput: 1.25, output: 10.00 }],
  ["o4-mini", { input: 1.10, cachedInput: 0.275, output: 4.40 }],
  ["o3-mini", { input: 1.10, cachedInput: 0.55, output: 4.40 }],
  ["o3", { input: 2.00, cachedInput: 0.50, output: 8.00 }],
  ["gpt-4", { input: 30.00, cachedInput: 30.00, output: 60.00 }]
];

// A model nobody has a rate for costs an unknown amount, which is a different
// statement from "costs nothing". Saying zero would quietly under-report a
// month; saying nothing lets the caller show the tokens and omit the money.
export function rateFor(providerId, model) {
  if (providerId === "ollama") return { input: 0, cachedInput: 0, output: 0, local: true };
  const name = String(model || "").toLowerCase();
  const found = RATES.find(([prefix]) => name.startsWith(prefix));
  return found ? { ...found[1], local: false } : null;
}

// The provider's own account of a turn, in the shapes the two of them use.
//
// OpenAI's Responses API reports input_tokens/output_tokens with a
// cached_tokens breakdown; Ollama reports prompt_eval_count/eval_count. Neither
// is guessed at — a turn whose usage never arrived reports zero rather than an
// estimate, because a made-up number in a spend report is worse than a gap.
export function readUsage(usage = {}) {
  const number = (value) => Math.max(0, Math.round(Number(value) || 0));
  const cached = number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const input = number(usage.input_tokens ?? usage.prompt_tokens ?? usage.prompt_eval_count);
  const output = number(usage.output_tokens ?? usage.completion_tokens ?? usage.eval_count);
  const reasoning = number(usage.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens: input,
    // Cached input cannot exceed input; a provider that reports otherwise would
    // otherwise produce a negative fresh-input figure and a nonsense cost.
    cachedInputTokens: Math.min(cached, input),
    outputTokens: output,
    reasoningTokens: Math.min(reasoning, output),
    totalTokens: input + output
  };
}

// Cost in micro-dollars, so it can be summed as an integer and never drifts the
// way accumulated floating-point cents do.
export function estimateMicros(providerId, model, tokens) {
  const rate = rateFor(providerId, model);
  if (!rate) return null;
  const fresh = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  const dollars = ((fresh * rate.input) + (tokens.cachedInputTokens * rate.cachedInput)
    + (tokens.outputTokens * rate.output)) / 1_000_000;
  return Math.round(dollars * 1_000_000);
}

// How a spend is written. Small amounts are the normal case on a chat turn, and
// rounding a tenth of a cent to "$0.00" makes a working meter look broken.
export function formatSpend(micros) {
  if (micros === null || micros === undefined) return "";
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatTokens(count) {
  const tokens = Math.max(0, Math.round(Number(count) || 0));
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
