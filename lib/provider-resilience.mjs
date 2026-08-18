// When a provider is having a bad minute, and when it is simply down.
//
// Those are different problems and they want opposite responses. A 429 or a
// dropped socket is worth trying again a moment later; a provider that has
// failed its last five requests is worth leaving alone, because every further
// attempt costs the person a timeout before they are told what they could have
// been told at once.
//
// Nothing here decides to use a different provider. It reports what it knows
// and lets the caller choose, because a silent substitution is the thing Evolv
// has consistently refused to do — an answer from a model you did not pick,
// with no indication that it happened, is worse than an error.

// Retried: the request never reached a model, or the provider asked us to wait.
// Not retried: anything the same request would deserve again — a bad key, a
// model that does not exist, a request the provider will not accept.
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// Transport failures never carry a status. A refused connection and a reset
// socket are the same story: nothing was answered, so asking again is safe.
const RETRIABLE_ERROR = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed|terminated/i;

export function isRetriableStatus(status) {
  return RETRIABLE_STATUS.has(Number(status));
}

export function isRetriableError(error) {
  if (!error) return false;
  // An abort is the person changing their mind, or a deadline we set. Retrying
  // it would ignore both.
  if (error.name === "AbortError") return false;
  return RETRIABLE_ERROR.test(`${error.code || ""} ${error.message || ""}`);
}

// Honour Retry-After when the provider sends one — it knows more than we do.
// Seconds or an HTTP date, both of which appear in the wild.
export function retryAfterMs(headers, now = Date.now()) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// Exponential with jitter. Without jitter, several conversations that failed
// together retry together and reproduce the burst that caused it.
export function backoffMs(attempt, { base = 400, cap = 8000, random = Math.random } = {}) {
  const ceiling = Math.min(cap, base * (2 ** Math.max(0, attempt - 1)));
  return Math.round(ceiling * (0.5 + (random() * 0.5)));
}

// One breaker per provider.
//
// Closed: requests go through. Open: they are refused immediately, because the
// last several failed and the person should hear that now rather than after
// another timeout. Half-open: one request is allowed through to find out
// whether the provider came back, and its result decides which way the breaker
// goes.
//
// Only failures that say something about the provider count. A rejected API key
// is a real fault but a permanent one, and tripping a breaker over it would
// hide the message that tells the person how to fix it.
export function createCircuitBreaker({ threshold = 5, coolOffMs = 30_000, clock = () => Date.now() } = {}) {
  const providers = new Map();
  // `open` is explicit rather than inferred from openedAt. A timestamp of 0 is
  // a real instant — an injected clock starting at zero found this immediately,
  // and a monotonic clock would have found it in production.
  const read = (id) => providers.get(id) || { failures: 0, open: false, openedAt: 0, halfOpen: false };

  return {
    // "May I send this?" — with the reason when the answer is no, because that
    // reason is what the person is shown.
    check(providerId) {
      const state = read(providerId);
      if (!state.open) return { allowed: true, state: "closed" };
      const waited = clock() - state.openedAt;
      if (waited < coolOffMs) {
        return {
          allowed: false,
          state: "open",
          retryInMs: coolOffMs - waited,
          reason: `${providerId} failed ${state.failures} times in a row. Waiting ${Math.ceil((coolOffMs - waited) / 1000)}s before trying it again.`
        };
      }
      providers.set(providerId, { ...state, halfOpen: true });
      return { allowed: true, state: "half-open" };
    },

    succeeded(providerId) {
      providers.delete(providerId);
    },

    failed(providerId, { counts = true } = {}) {
      if (!counts) return read(providerId);
      const state = read(providerId);
      const failures = state.failures + 1;
      // A failure while half-open reopens immediately: the provider was given
      // its chance and did not take it.
      const open = failures >= threshold || state.halfOpen;
      const next = {
        failures,
        open: open || state.open,
        openedAt: open ? clock() : state.openedAt,
        halfOpen: false
      };
      providers.set(providerId, next);
      return next;
    },

    // For tests and for showing state in the interface.
    snapshot() {
      return Object.fromEntries([...providers.entries()].map(([id, state]) => [id, { ...state }]));
    }
  };
}

// The retry loop itself, kept separate from the breaker so each can be read and
// tested on its own.
//
// `send` performs one attempt and returns a Response. Anything it throws is
// inspected rather than swallowed: a retriable transport failure is tried
// again, and everything else is rethrown untouched so the caller still sees the
// real error rather than a wrapper.
export async function withRetry(send, {
  attempts = 3,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
  random = Math.random
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw Object.assign(new Error("Request aborted."), { name: "AbortError" });
    try {
      const response = await send(attempt);
      if (!isRetriableStatus(response.status) || attempt === attempts) return response;
      const wait = retryAfterMs(response.headers) ?? backoffMs(attempt, { random });
      onRetry({ attempt, waitMs: wait, status: response.status });
      await sleep(wait);
    } catch (error) {
      if (!isRetriableError(error) || attempt === attempts) throw error;
      lastError = error;
      const wait = backoffMs(attempt, { random });
      onRetry({ attempt, waitMs: wait, error: error.message });
      await sleep(wait);
    }
  }
  // Only reachable if the final attempt threw a retriable error, which the loop
  // above rethrows — kept so the function has no silent path out.
  throw lastError || new Error("Request failed.");
}
