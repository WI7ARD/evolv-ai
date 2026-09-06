import { inspectOllamaRequest, inspectOpenAiResponsesInput, reportRequestProblems } from "./provider-contract.mjs";
import { bridgeToLegacy } from "./ai-event-bridge.mjs";
import { createCircuitBreaker, withRetry } from "./provider-resilience.mjs";
import { streamOpenAiResponses } from "./openai-responses.mjs";

// Two providers, deliberately.
//
// Evolv used to speak six. Each spoke a different dialect — Anthropic's content
// blocks, Gemini's steps with their signatures, two flavours of OpenAI-shaped
// chat-completions — and about two thirds of this file was the seam between
// them. Every one of those seams was a place to be subtly wrong in a way only
// that provider would notice, and several were: a pinned API revision that
// silently drifted, a 400 that really meant 401, an inspector wired to nothing.
//
// What is left is the pair that actually earns its keep: the local one Evolv is
// built around, and one cloud one for when a local model is not enough. Adding
// a third is a real decision to be made again, not a table to append to.
const DEFINITIONS = {
  ollama: { id: "ollama", name: "Ollama", requiresKey: false, baseUrl: "http://127.0.0.1:11434" },
  openai: { id: "openai", name: "OpenAI", requiresKey: true, baseUrl: "https://api.openai.com/v1" }
};

export const PROVIDER_IDS = Object.freeze(Object.keys(DEFINITIONS));

// A bare status code is not a diagnosis. Every provider says exactly what is
// wrong in the response body — which model does not exist, which parameter it
// rejected — and throwing that away leaves someone holding "Gemini chat failed
// (404)" with nowhere to go. Gemini's SSE errors arrive as a one-element array,
// which is why the array case is handled rather than assumed away.
async function describeFailure(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  let payload;
  try { payload = JSON.parse(raw); } catch { return raw.slice(0, 200).trim(); }
  const first = Array.isArray(payload) ? payload[0] : payload;
  const message = first?.error?.message || first?.error?.error?.message
    || first?.message || first?.error?.status || "";
  return String(message || raw).slice(0, 300).trim();
}

async function failedRequest(name, verb, response, malformed = "") {
  const detail = await describeFailure(response);
  // When Evolv already knew the request was malformed, say so plainly. The
  // provider's own sentence names an index into a request nobody can see, and
  // reading it as a fault of the model is the wrong conclusion to reach.
  const blame = malformed ? ` This is a bug in Evolv rather than the model: ${malformed}.` : "";
  return providerError(
    `${name} ${verb} failed (${response.status})${detail ? `: ${detail}` : ""}${blame}`,
    response.status === 401 || response.status === 403 ? 401 : 502
  );
}

function providerError(message, status = 502, code = "PROVIDER_ERROR") {
  return Object.assign(new Error(message), { status, code, expose: true });
}

// What to say when a provider cannot be reached at all. Ollama runs on this
// machine, so the fix is to start it; a cloud provider is a network problem.
// The Ollama wording matches /api/health word for word — the same condition
// described two different ways is how people conclude an app is broken.
function unreachableMessage(providerId, baseUrl) {
  if (providerId === "ollama") return `Cannot reach Ollama at ${baseUrl}. Start Ollama, then refresh.`;
  const name = DEFINITIONS[providerId]?.name || "The AI provider";
  return `Cannot reach ${name}. Check your internet connection, then try again.`;
}

function authHeaders(providerId, apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

// Exported so the vendor naming this has to keep up with can be pinned by name
// in a test, rather than noticed when a new model quietly loses a capability.
export function conservativeCapabilities(providerId, model, metadata = {}) {
  const name = String(model).toLowerCase();
  if (providerId === "ollama") return metadata.capabilities || [];
  return ["completion", ...(/gpt-4|gpt-5|o[1-9]/.test(name) ? ["tools"] : []),
    ...(/gpt-4o|gpt-4\.1|gpt-5/.test(name) ? ["vision"] : []),
    ...(/(^|[-/])o[1-9]|gpt-5/.test(name) ? ["thinking"] : [])];
}
// Provider model listings are not chat menus. OpenAI's /v1/models returns every
// model the key can touch — image, audio, embedding, moderation, and legacy
// completion models included — and each one offered as a chat option produces
// exactly one outcome: the user picks it and the provider answers 404. Gemini
// has the same trap in a different shape, listing models that support
// generateContent but not the streaming call chat actually makes.
//
// These patterns are deliberately conservative. Excluding a working model is a
// missing entry in a dropdown; including a broken one is an error the user
// cannot diagnose or act on.
const NOT_CHAT_MODELS = /(^|[-/])(dall-e|sora|whisper|tts|gpt-image|omni-moderation|text-moderation|text-embedding|davinci-\d|babbage-\d)|[-/](embed|embedding|moderation|realtime|instruct)(-|$)/i;

function chatCapable(providerId, item, id) {
  if (providerId === "ollama") return true;
  return !NOT_CHAT_MODELS.test(String(id));
}

function toModel(providerId, item, configuredCapabilities = {}) {
  const id = item.id || item.name || item.model;
  const display = item.displayName || item.name || id;
  return {
    provider: providerId,
    id: String(id).replace(/^models\//, ""),
    name: String(id).replace(/^models\//, ""),
    displayName: display,
    size: item.size,
    parameterSize: item.details?.parameter_size || "",
    family: item.details?.family || providerId,
    contextLength: item.context_length || item.inputTokenLimit || null,
    capabilities: conservativeCapabilities(providerId, id, { ...item, configuredCapabilities }),
    supportsThinking: conservativeCapabilities(providerId, id, { ...item, configuredCapabilities }).includes("thinking"),
    usesThinkingLevels: /gpt-oss/i.test(id)
  };
}

// Tool arguments arrive as a JSON string the model wrote, so they can be
// malformed. A SyntaxError here would abort the whole request with a stack
// trace instead of a reply; an empty object lets the tool refuse the call on
// its own terms, which it already knows how to do.
function toolArguments(call) {
  const raw = call.function?.arguments;
  if (typeof raw !== "string") return raw || {};
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

// The provider-shaped message lists, extracted so their output can be checked
// without a network round trip. Every bug this file has had was a shape one
// provider accepts and another refuses, which is only cheap to test once the
// shape can be built directly.
// Ollama's own shape. It was previously sent the stored message verbatim, which
// works right up until the conversation was started somewhere else: OpenAI
// returns tool arguments as a JSON string and Ollama expects an object, so
// rotating from a cloud model back to a local one handed Ollama arguments it
// could not read. The mirror image of the missing call ids going the other way.
export function toOllamaMessages(messages = []) {
  return messages.map((message) => ({
    role: message.role,
    content: String(message.content || ""),
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.tool_calls?.length
      ? { tool_calls: message.tool_calls.map((call) => ({ function: { name: call.function?.name, arguments: toolArguments(call) } })) }
      : {})
  }));
}

// Model capabilities are immutable per (name, digest), so probe results are
// shared across profiles and survive list refreshes.
const ollamaCapabilityCache = new Map();

export function createProviderService({ database, secretStore, ollamaUrl, providerBaseUrls = {}, logger = null }) {
  const cache = new Map();
  // One breaker for the whole service, so every route to a provider — models,
  // chat, capability probes — contributes to and reads the same judgement about
  // whether that provider is currently answering.
  const breaker = createCircuitBreaker();

  function credential(providerId) {
    return database.getProviderCredential(providerId);
  }

  async function config(providerId) {
    const definition = DEFINITIONS[providerId];
    if (!definition) throw providerError("Unknown AI provider.", 404, "UNKNOWN_PROVIDER");
    const saved = credential(providerId);
    if (definition.requiresKey && !saved?.encryptedSecret) {
      throw providerError(`${definition.name} is not configured. Add its API key in Settings.`, 409, "PROVIDER_NOT_CONFIGURED");
    }
    const baseUrl = saved?.baseUrl || providerBaseUrls[providerId] || (providerId === "ollama" ? ollamaUrl : definition.baseUrl);
    return {
      definition,
      saved,
      baseUrl,
      apiKey: saved?.encryptedSecret ? await secretStore.decrypt(saved.encryptedSecret) : ""
    };
  }

  async function providerFetch(providerId, route, options = {}) {
    const current = await config(providerId);
    // A provider that has failed its last several requests is refused here
    // rather than after another timeout. The message says which provider, how
    // many times, and how long until it is tried again.
    const gate = breaker.check(providerId);
    if (!gate.allowed) throw providerError(gate.reason, 503, "PROVIDER_CIRCUIT_OPEN");

    const { retryTransient, ...init } = options;
    const send = () => fetch(`${current.baseUrl}${route}`, {
      ...init,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...authHeaders(providerId, current.apiKey),
        ...(init.headers || {})
      }
    });
    let response;
    try {
      // Only where the caller asked. A retried request is a request sent twice,
      // which is safe for the reads and completions that opt in and is not
      // something to decide on anyone else's behalf.
      response = retryTransient
        ? await withRetry(send, {
          signal: init.signal,
          onRetry: ({ attempt, waitMs, status, error }) => logger?.warn?.("provider.retry", {
            provider: providerId, route, attempt, waitMs, status, error
          })
        })
        : await send();
    } catch (error) {
      // A refused connection is not an internal error, and reporting it as one
      // is how a first run with no Ollama greets someone: "Unexpected server
      // error. Reference: 0427fd05-…". The app already knows what happened —
      // /api/health says so plainly — so say the same thing everywhere.
      //
      // 503 is deliberate: the request handler exposes messages on 4xx and on
      // 503 only, so this reaches the user intact instead of being swallowed
      // into a reference id.
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      breaker.failed(providerId);
      throw providerError(unreachableMessage(providerId, current.baseUrl), 503, "PROVIDER_UNREACHABLE");
    }
    if (response.status >= 300 && response.status < 400) throw providerError("AI provider redirects are not allowed.", 502, "PROVIDER_REDIRECT");
    const rejectedCredential = response.status === 401 || response.status === 403;
    if (rejectedCredential) {
      cache.delete(providerId);
      if (providerId !== "ollama" && credential(providerId)) {
        database.setProviderStatus(providerId, "error", "API key rejected or revoked. Replace the key to reconnect.");
      }
      // This is deliberately not HTTP 401: that status is reserved for the
      // local Evolv session and would otherwise send the renderer to login.
      // A bad key is a real fault and a permanent one. Counting it would trip
      // the breaker and bury the message that tells the person how to fix it.
      breaker.failed(providerId, { counts: false });
      throw providerError(`${current.definition.name} rejected its API key. Replace the key in Settings.`, 424, "PROVIDER_AUTH_FAILED");
    }
    if (response.status >= 500) breaker.failed(providerId);
    else breaker.succeeded(providerId);
    return response;
  }

  async function models(providerId, { refresh = false } = {}) {
    const cached = cache.get(providerId);
    if (!refresh && cached && Date.now() - cached.createdAt < 300_000) return cached.models;
    let result;
    if (providerId === "ollama") {
      const response = await providerFetch(providerId, "/api/tags");
      if (!response.ok) throw providerError(`Ollama returned ${response.status}.`);
      const payload = await response.json();
      result = await Promise.all((payload.models || []).map(async (item) => {
        const cacheKey = `${item.name || item.model}:${item.digest || ""}`;
        let capabilities = ollamaCapabilityCache.get(cacheKey);
        if (!capabilities) {
          capabilities = [];
          try {
            const shown = await providerFetch("ollama", "/api/show", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: item.name || item.model })
            });
            capabilities = shown.ok ? (await shown.json()).capabilities || [] : [];
          } catch {}
          if (capabilities.length) ollamaCapabilityCache.set(cacheKey, capabilities);
        }
        return toModel("ollama", { ...item, capabilities });
      }));
    } else {
      const response = await providerFetch(providerId, "/models");
      if (!response.ok) throw await failedRequest(DEFINITIONS[providerId].name, "model list", response);
      const payload = await response.json();
      result = (payload.data || payload.models || [])
        .filter((item) => chatCapable(providerId, item, item.id || item.name || item.model))
        .map((item) => toModel(providerId, item, credential(providerId)?.capabilities || {}));
    }
    result = result.filter((item) => !item.capabilities.length || !item.capabilities.every((capability) => capability === "embedding"));
    cache.set(providerId, { createdAt: Date.now(), models: result });
    return result;
  }

  async function saveCredentials(providerId, body) {
    const definition = DEFINITIONS[providerId];
    if (!definition) throw providerError("Unknown AI provider.", 404, "UNKNOWN_PROVIDER");
    let baseUrl = "";
    if (providerId === "ollama" && body.baseUrl) {
      const parsed = new URL(body.baseUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw providerError("Enter a valid Ollama URL.", 400, "INVALID_BASE_URL");
      }
      baseUrl = parsed.toString().replace(/\/$/, "");
    }
    let encryptedSecret = credential(providerId)?.encryptedSecret || "";
    if (definition.requiresKey && body.apiKey != null) {
      const apiKey = String(body.apiKey).trim();
      if (apiKey.length < 8 || apiKey.length > 1000) throw providerError("API key must be 8–1000 characters.", 400, "INVALID_API_KEY");
      encryptedSecret = await secretStore.encrypt(apiKey);
    }
    if (definition.requiresKey && !encryptedSecret) throw providerError("API key is required.", 400, "INVALID_API_KEY");
    cache.delete(providerId);
    database.saveProviderCredential({ providerId, encryptedSecret, baseUrl, capabilities: {} });
    return publicProvider(providerId);
  }

  function publicProvider(providerId) {
    const definition = DEFINITIONS[providerId];
    const saved = credential(providerId);
    return {
      ...definition,
      configured: providerId === "ollama" || Boolean(saved?.encryptedSecret),
      baseUrl: saved?.baseUrl || providerBaseUrls[providerId] || (providerId === "ollama" ? ollamaUrl : definition.baseUrl),
      capabilities: saved?.capabilities || {},
      status: saved?.status || (providerId === "ollama" ? "local" : "not-configured"),
      statusMessage: saved?.statusMessage || "",
      testedAt: saved?.testedAt || null,
      secretStorageAvailable: secretStore.available,
      secretStorageDescription: secretStore.description
    };
  }

  async function test(providerId) {
    try {
      const discovered = await models(providerId, { refresh: true });
      if (providerId !== "ollama") database.setProviderStatus(providerId, "ready", `${discovered.length} chat models available`);
      return { ok: true, modelCount: discovered.length, provider: publicProvider(providerId) };
    } catch (error) {
      if (providerId !== "ollama" && credential(providerId)) database.setProviderStatus(providerId, "error", error.message);
      throw error;
    }
  }

  async function streamOllama(payload, signal, onChunk) {
    // maxTokens is a cloud-provider option; Ollama gets its own option names.
    const { maxTokens, ...options } = payload.options || {};
    const messages = toOllamaMessages(payload.messages);
    reportRequestProblems("Ollama", inspectOllamaRequest(messages));
    const response = await providerFetch("ollama", "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, messages, options, stream: true }),
      signal
    });
    if (!response.ok) throw providerError(`Ollama returned ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let warned = false;
    const emit = (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (!warned) console.warn("Skipped a malformed Ollama stream line.");
        warned = true;
        return;
      }
      onChunk(parsed);
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) emit(line);
      if (done) break;
    }
    if (buffer.trim()) emit(buffer);
  }

  async function streamRound(providerId, payload, signal, onChunk) {
    if (providerId === "ollama") return streamOllama(payload, signal, onChunk);
    if (providerId === "openai") {
      // Checked before it goes rather than after it fails. OpenAI answers a
      // malformed request with a sentence naming an index into a body nobody
      // can see, so Evolv's own reading of what it built is the only
      // description of the problem anyone is going to get. The inspector used
      // to exist and be wired to nothing here — this call is the fix.
      let problems = "";
      const result = await streamOpenAiResponses({
        payload,
        signal,
        request: (route, options) => {
          if (options?.body) {
            problems = reportRequestProblems("OpenAI", inspectOpenAiResponsesInput(JSON.parse(options.body).input));
          }
          return providerFetch("openai", route, options);
        },
        onEvent: bridgeToLegacy(onChunk)
      });
      if (!result.response.ok) throw await failedRequest("OpenAI", "chat", result.response, problems);
      return;
    }
    // Unreachable through the UI, which offers two providers. Reachable through
    // a stored setting written by an older build, and silence there would look
    // like a model that answers nothing.
    throw providerError(`Evolv does not support the provider "${providerId}". Choose Ollama or OpenAI in Settings.`, 400, "UNKNOWN_PROVIDER");
  }

  return {
    definitions: DEFINITIONS,
    list: () => Object.keys(DEFINITIONS).map(publicProvider),
    models,
    // Anything that changes what a provider holds has to say so. The list is
    // cached for five minutes, and installing a model used to leave that cache
    // untouched: the sidebar said "Evolv Local ready" — health asks Ollama
    // directly — while the model dropdown kept serving the list from before the
    // install, so the model you had just downloaded was not selectable.
    invalidateModels(providerId) { cache.delete(providerId); },
    // What the breaker currently believes, for the interface and for tests.
    circuitState: () => breaker.snapshot(),
    saveCredentials,
    deleteCredentials(providerId) {
      cache.delete(providerId);
      return database.deleteProviderCredential(providerId);
    },
    test,
    streamRound,
    capabilities: async (providerId, modelId) => {
      if (providerId === "ollama") {
        const response = await providerFetch("ollama", "/api/show", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: modelId })
        });
        if (!response.ok) return ["completion"];
        const payload = await response.json();
        return payload.capabilities || ["completion"];
      }
      const found = (await models(providerId)).find((model) => model.id === modelId || model.name === modelId);
      return found?.capabilities || ["completion"];
    }
  };
}
