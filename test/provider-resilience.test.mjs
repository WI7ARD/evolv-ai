import test from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs, createCircuitBreaker, isRetriableError, isRetriableStatus, retryAfterMs, withRetry
} from "../lib/provider-resilience.mjs";

// A provider having a bad minute and a provider being down want opposite
// responses. Retrying the first is right; retrying the second costs the person
// a timeout before telling them what could have been said immediately.

test("only failures worth repeating are repeated", () => {
  // Nothing reached a model, or the provider asked us to wait.
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetriableStatus(status), true, `${status}`);
  // The same request would earn the same answer: a bad key, a missing model, a
  // shape the provider will not take.
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetriableStatus(status), false, `${status}`);

  assert.equal(isRetriableError({ code: "ECONNRESET" }), true);
  assert.equal(isRetriableError({ message: "fetch failed" }), true);
  // An abort is the person changing their mind, or a deadline we set ourselves.
  assert.equal(isRetriableError({ name: "AbortError", message: "aborted" }), false);
  assert.equal(isRetriableError(new TypeError("bad argument")), false);
});

test("the provider's own Retry-After outranks our guess", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" })), 2000);
  const at = new Date(Date.now() + 5000).toUTCString();
  assert.ok(Math.abs(retryAfterMs(new Headers({ "retry-after": at })) - 5000) < 1500);
  assert.equal(retryAfterMs(new Headers()), null);
});

test("backoff grows and is jittered", () => {
  // Without jitter, conversations that failed together retry together and
  // reproduce the burst that caused it.
  const low = backoffMs(3, { random: () => 0 });
  const high = backoffMs(3, { random: () => 0.999 });
  assert.ok(low < high, "jitter spreads the retries");
  assert.ok(backoffMs(1, { random: () => 1 }) < backoffMs(4, { random: () => 0 }), "later attempts wait longer");
  assert.ok(backoffMs(50, { random: () => 1 }) <= 8000, "and the wait is capped");
});

test("a transient failure is retried, a permanent one is not", async () => {
  let calls = 0;
  const waits = [];
  const flaky = await withRetry(async () => {
    calls += 1;
    return calls < 3 ? new Response("", { status: 503 }) : new Response("ok", { status: 200 });
  }, { sleep: async (ms) => waits.push(ms), random: () => 0.5 });
  assert.equal(flaky.status, 200);
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);

  let permanent = 0;
  const refused = await withRetry(async () => {
    permanent += 1;
    return new Response("", { status: 400 });
  }, { sleep: async () => {} });
  assert.equal(refused.status, 400);
  assert.equal(permanent, 1, "a 400 is not asked again");
});

test("the breaker opens after repeated failure and closes when the provider returns", () => {
  let now = 0;
  const breaker = createCircuitBreaker({ threshold: 3, coolOffMs: 30_000, clock: () => now });

  assert.equal(breaker.check("openai").allowed, true);
  breaker.failed("openai");
  breaker.failed("openai");
  assert.equal(breaker.check("openai").allowed, true, "two failures is a bad minute, not an outage");

  breaker.failed("openai");
  const open = breaker.check("openai");
  assert.equal(open.allowed, false);
  // The message is what the person is shown, so it has to say which provider,
  // how many times, and how long.
  assert.match(open.reason, /openai failed 3 times/);
  assert.match(open.reason, /30s/);

  now += 30_000;
  const probe = breaker.check("openai");
  assert.equal(probe.allowed, true, "after the cool-off one request is let through");
  assert.equal(probe.state, "half-open");

  breaker.succeeded("openai");
  assert.equal(breaker.check("openai").state, "closed");
  assert.deepEqual(breaker.snapshot(), {});
});

test("a failure while half-open reopens without waiting for the threshold again", () => {
  let now = 0;
  const breaker = createCircuitBreaker({ threshold: 2, coolOffMs: 1000, clock: () => now });
  breaker.failed("gemini");
  breaker.failed("gemini");
  assert.equal(breaker.check("gemini").allowed, false);

  now += 1000;
  assert.equal(breaker.check("gemini").state, "half-open");
  breaker.failed("gemini");
  assert.equal(breaker.check("gemini").allowed, false, "the provider was given its chance");
});

test("a rejected API key does not trip the breaker", () => {
  // It is a real fault and a permanent one. Opening the circuit over it would
  // bury the message that tells the person how to fix it behind a cool-off.
  const breaker = createCircuitBreaker({ threshold: 2 });
  breaker.failed("anthropic", { counts: false });
  breaker.failed("anthropic", { counts: false });
  assert.equal(breaker.check("anthropic").allowed, true);
});

test("one provider being down says nothing about another", () => {
  const breaker = createCircuitBreaker({ threshold: 1 });
  breaker.failed("openai");
  assert.equal(breaker.check("openai").allowed, false);
  assert.equal(breaker.check("gemini").allowed, true);
});
