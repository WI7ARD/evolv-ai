import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { createProviderService } from "../lib/providers.mjs";
import { isRetriableStatus, isRetriableError, retryAfterMs, backoffMs, createCircuitBreaker, withRetry } from "../lib/provider-resilience.mjs";

// Every way a provider can fail, against every provider, in one place.
//
// The retry rules, the breaker, and the messages were each tested on their own
// and each behaved. What was never checked is the combination — and the
// combination is where the interesting mistakes are. Retrying a rejected API
// key wastes three requests to be told the same thing. Tripping the breaker on
// that key hides the one message that says how to fix it. Retrying a 400 sends
// a request the provider has already explained it will not accept.
//
// The matrix is the specification: for each failure, was it retried, did it
// count against the provider, and what is the person told.

const PROVIDERS = ["ollama", "openai", "anthropic", "gemini", "openrouter"];

// Every failure Evolv can meet, and what should happen. `counts` means it
// contributes to opening the circuit breaker.
const FAILURES = [
  { name: "400 the provider will not accept", status: 400, retried: false, counts: false },
  { name: "401 rejected key", status: 401, retried: false, counts: false, auth: true },
  { name: "403 forbidden", status: 403, retried: false, counts: false, auth: true },
  { name: "404 no such model", status: 404, retried: false, counts: false },
  { name: "408 request timeout", status: 408, retried: true, counts: false },
  { name: "409 conflict", status: 409, retried: true, counts: false },
  { name: "422 unprocessable", status: 422, retried: false, counts: false },
  { name: "429 rate limited", status: 429, retried: true, counts: false },
  { name: "500 provider fault", status: 500, retried: true, counts: true },
  { name: "502 bad gateway", status: 502, retried: true, counts: true },
  { name: "503 unavailable", status: 503, retried: true, counts: true },
  { name: "504 gateway timeout", status: 504, retried: true, counts: true }
];

const TRANSPORT = [
  { name: "connection refused", code: "ECONNREFUSED", retried: true },
  { name: "connection reset", code: "ECONNRESET", retried: true },
  { name: "DNS failure", code: "EAI_AGAIN", retried: true },
  { name: "socket hang up", message: "socket hang up", retried: true },
  { name: "fetch failed", message: "fetch failed", retried: true },
  { name: "the person pressed stop", name_: "abort", abort: true, retried: false }
];

test("the retry rule is the same for every provider and every status", () => {
  for (const failure of FAILURES) {
    assert.equal(isRetriableStatus(failure.status), failure.retried,
      `${failure.name}: expected retried=${failure.retried}`);
  }
});

test("a transport failure is retried; a cancellation never is", () => {
  for (const failure of TRANSPORT) {
    const error = failure.abort
      ? Object.assign(new Error("Request aborted."), { name: "AbortError" })
      : Object.assign(new Error(failure.message || "boom"), { code: failure.code });
    assert.equal(isRetriableError(error), failure.retried, `${failure.name}`);
  }
  // An abort carrying a retriable-looking code is still an abort. The person
  // pressed stop, or a deadline we set expired; sending it again ignores both.
  const abortedReset = Object.assign(new Error("ECONNRESET"), { name: "AbortError", code: "ECONNRESET" });
  assert.equal(isRetriableError(abortedReset), false);
});

test("the provider's own Retry-After beats our arithmetic", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "30" })), 30_000);
  const at = new Date(Date.now() + 5_000).toUTCString();
  const parsed = retryAfterMs(new Headers({ "retry-after": at }));
  assert.ok(parsed >= 3_000 && parsed <= 6_000, `an HTTP date is honoured too (got ${parsed})`);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "-5" })), 0, "never negative");
  assert.equal(retryAfterMs(new Headers()), null, "and absent means absent, not zero");
});

test("backoff climbs, is capped, and is never the same for two callers", () => {
  const ceiling = (attempt) => backoffMs(attempt, { random: () => 1 });
  assert.ok(ceiling(1) < ceiling(2) && ceiling(2) < ceiling(3));
  assert.equal(ceiling(20), 8000, "capped, so a long outage does not become a long sleep");
  const floor = backoffMs(3, { random: () => 0 });
  assert.ok(floor < ceiling(3), "jitter spreads the retries that failed together");
});

test("the breaker opens on provider faults and ignores everything else", () => {
  let clock = 0;
  for (const failure of FAILURES.filter((item) => !item.counts)) {
    const breaker = createCircuitBreaker({ clock: () => clock });
    for (let attempt = 0; attempt < 10; attempt += 1) breaker.failed("openai", { counts: false });
    assert.equal(breaker.check("openai").allowed, true, `${failure.name} must not open the breaker`);
  }
  const breaker = createCircuitBreaker({ threshold: 5, coolOffMs: 30_000, clock: () => clock });
  for (let attempt = 0; attempt < 4; attempt += 1) breaker.failed("openai");
  assert.equal(breaker.check("openai").allowed, true, "four failures is a bad minute, not an outage");
  breaker.failed("openai");
  const refused = breaker.check("openai");
  assert.equal(refused.allowed, false);
  assert.match(refused.reason, /openai failed 5 times/);
  assert.match(refused.reason, /30s/, "and says how long, because a wait nobody can see is worse than an error");

  // One provider going down does not take the others with it.
  assert.equal(breaker.check("anthropic").allowed, true);

  clock += 30_000;
  const probe = breaker.check("openai");
  assert.equal(probe.state, "half-open", "after the cool-off, one request finds out");
  breaker.failed("openai");
  assert.equal(breaker.check("openai").allowed, false, "a failed probe reopens immediately");
  clock += 30_000;
  breaker.check("openai");
  breaker.succeeded("openai");
  assert.equal(breaker.check("openai").state, "closed", "and a success clears it completely");
});

test("a retried request stops as soon as it succeeds", async () => {
  let sent = 0;
  const response = await withRetry(async () => {
    sent += 1;
    return new Response("", { status: sent < 3 ? 503 : 200 });
  }, { sleep: async () => {}, attempts: 5 });
  assert.equal(response.status, 200);
  assert.equal(sent, 3, "three sends, not five");
});

test("a retried request gives up and returns the last real answer", async () => {
  let sent = 0;
  const response = await withRetry(async () => {
    sent += 1;
    return new Response("", { status: 503 });
  }, { sleep: async () => {}, attempts: 3 });
  assert.equal(sent, 3);
  assert.equal(response.status, 503, "the provider's own answer is returned, not a wrapper around it");
});

test("a cancelled request is not retried, and says it was cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  let sent = 0;
  await assert.rejects(
    () => withRetry(async () => { sent += 1; return new Response("", { status: 503 }); },
      { signal: controller.signal, sleep: async () => {} }),
    (error) => error.name === "AbortError"
  );
  assert.equal(sent, 0, "an already-cancelled request is never sent at all");
});

// The rules above, exercised through the real service against every provider.

async function withService(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-matrix-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "m.db"), defaultPrompt: "test" });
  const secretStore = {
    available: true,
    description: "test",
    encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString()
  };
  const service = createProviderService({
    database,
    secretStore,
    ollamaUrl: "http://127.0.0.1:11434",
    providerBaseUrls: Object.fromEntries(PROVIDERS.map((id) => [id, `http://127.0.0.1:9/${id}`]))
  });
  for (const providerId of PROVIDERS) {
    if (providerId !== "ollama") await service.saveCredentials(providerId, { apiKey: `key-for-${providerId}` });
  }
  const realFetch = globalThis.fetch;
  try {
    await run(service, (impl) => { globalThis.fetch = impl; });
  } finally {
    globalThis.fetch = realFetch;
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a rejected key is never retried, never counted, and always says what to do", async () => {
  await withService(async (service, stubFetch) => {
    for (const providerId of PROVIDERS.filter((id) => id !== "ollama")) {
      let sent = 0;
      stubFetch(async () => { sent += 1; return new Response("{}", { status: 401 }); });
      await assert.rejects(() => service.models(providerId, { refresh: true }), (error) => {
        assert.equal(error.code, "PROVIDER_AUTH_FAILED", providerId);
        assert.match(error.message, /Replace the key in Settings/, providerId);
        // Not 401: that status is the local Evolv session's, and returning it
        // here would bounce the person to a login screen over a provider key.
        assert.equal(error.status, 424, providerId);
        return true;
      });
      assert.equal(sent, 1, `${providerId}: a bad key is not worth three attempts`);
      assert.equal(service.circuitState()[providerId]?.open, undefined,
        `${providerId}: a fixable key must not trip the breaker and bury its own message`);
    }
  });
});

test("an unreachable provider is named, not turned into a reference number", async () => {
  await withService(async (service, stubFetch) => {
    for (const providerId of PROVIDERS) {
      stubFetch(async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }); });
      await assert.rejects(() => service.models(providerId, { refresh: true }), (error) => {
        assert.equal(error.code, "PROVIDER_UNREACHABLE", providerId);
        // 503 is load-bearing: the request handler exposes messages on 4xx and
        // 503 only, so anything else here reaches the person as a reference id.
        assert.equal(error.status, 503, providerId);
        assert.ok(error.message.length > 20, providerId);
        return true;
      });
    }
  });
});

test("a provider that keeps failing is refused before the timeout, and says for how long", async () => {
  await withService(async (service, stubFetch) => {
    stubFetch(async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }); });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.models("openai", { refresh: true }).catch(() => {});
    }
    let sent = 0;
    stubFetch(async () => { sent += 1; return new Response("{}", { status: 200 }); });
    await assert.rejects(() => service.models("openai", { refresh: true }), (error) => {
      assert.equal(error.code, "PROVIDER_CIRCUIT_OPEN");
      assert.equal(error.status, 503);
      assert.match(error.message, /openai failed 5 times in a row/);
      assert.match(error.message, /before trying it again/);
      return true;
    });
    assert.equal(sent, 0, "the refused request never leaves the machine");
    // And it is one provider's problem, not everyone's.
    assert.equal(service.circuitState().anthropic, undefined);
  });
});

test("a redirect is refused rather than followed", async () => {
  // Following one would send an API key to whichever host the redirect names.
  await withService(async (service, stubFetch) => {
    stubFetch(async () => new Response("", { status: 302, headers: { location: "http://elsewhere.invalid/" } }));
    await assert.rejects(() => service.models("openai", { refresh: true }), (error) => {
      assert.equal(error.code, "PROVIDER_REDIRECT");
      return true;
    });
  });
});

test("Gemini reporting a dead key as 400 is still read as a dead key", async () => {
  // Gemini answers a revoked key with 400 and the reason in the body, where
  // every other provider answers 401. Missing this told people their request
  // was malformed when their key had expired.
  await withService(async (service, stubFetch) => {
    stubFetch(async () => new Response(JSON.stringify({
      error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    await assert.rejects(() => service.models("gemini", { refresh: true }), (error) => {
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      return true;
    });
  });
});
