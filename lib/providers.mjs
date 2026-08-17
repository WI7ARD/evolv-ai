import dns from "node:dns/promises";
import net from "node:net";
import {
  inspectAnthropicRequest, inspectGeminiRequest, inspectOllamaRequest, inspectOpenAiRequest, reportRequestProblems
} from "./provider-contract.mjs";
import { imageMediaType } from "./images.mjs";

const DEFINITIONS = {
  ollama: { id: "ollama", name: "Ollama", requiresKey: false, baseUrl: "http://127.0.0.1:11434" },
  openai: { id: "openai", name: "OpenAI", requiresKey: true, baseUrl: "https://api.openai.com/v1" },
  anthropic: { id: "anthropic", name: "Anthropic", requiresKey: true, baseUrl: "https://api.anthropic.com/v1" },
  gemini: { id: "gemini", name: "Google Gemini", requiresKey: true, baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  openrouter: { id: "openrouter", name: "OpenRouter", requiresKey: true, baseUrl: "https://openrouter.ai/api/v1" },
  custom: { id: "custom", name: "Custom OpenAI-compatible", requiresKey: true, baseUrl: "" }
};

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

function isPrivateIp(address) {
  if (address === "::1" || address.startsWith("127.")) return "loopback";
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || a >= 224) return "private";
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd") || lower === "::") return "private";
  }
  return "";
}

async function validateCustomBaseUrl(value, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw providerError("Enter a valid custom API base URL.", 400, "INVALID_BASE_URL");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw providerError("Custom API URLs cannot contain credentials, queries, or fragments.", 400, "INVALID_BASE_URL");
  }
  const loopbackName = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackName)) {
    throw providerError("Custom APIs must use HTTPS; HTTP is allowed only on this computer.", 400, "INVALID_BASE_URL");
  }
  if (!loopbackName) {
    let addresses;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw providerError("The custom API hostname could not be resolved.", 400, "INVALID_BASE_URL");
    }
    if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
      throw providerError("Custom APIs cannot target private, link-local, or loopback networks.", 400, "PRIVATE_ENDPOINT");
    }
  }
  return url.toString().replace(/\/$/, "");
}

function authHeaders(providerId, apiKey) {
  if (providerId === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  if (providerId === "gemini") return { "x-goog-api-key": apiKey };
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

// Exported so the vendor naming this has to keep up with can be pinned by name
// in a test, rather than noticed when a new model quietly loses a capability.
export function conservativeCapabilities(providerId, model, metadata = {}) {
  const name = String(model).toLowerCase();
  if (providerId === "ollama") return metadata.capabilities || [];
  if (providerId === "openrouter") {
    const parameters = metadata.supported_parameters || [];
    const inputs = metadata.architecture?.input_modalities || [];
    return [
      "completion",
      ...(parameters.includes("tools") ? ["tools"] : []),
      ...(inputs.includes("image") ? ["vision"] : []),
      ...(parameters.some((item) => /reason|thinking/.test(item)) ? ["thinking"] : [])
    ];
  }
  if (providerId === "openai") {
    return ["completion", ...(/gpt-4|gpt-5|o[1-9]/.test(name) ? ["tools"] : []),
      ...(/gpt-4o|gpt-4\.1|gpt-5/.test(name) ? ["vision"] : []),
      ...(/(^|[-/])o[1-9]|gpt-5/.test(name) ? ["thinking"] : [])];
  }
  if (providerId === "anthropic") {
    // Anthropic names models both ways round — claude-3-7-sonnet, but also
    // claude-opus-5 — and a pattern listing the generations it knew about went
    // stale the moment the next one shipped, silently downgrading it to a model
    // with no reasoning. Extended thinking arrived in 3.7, so the test is
    // "3.7 or later" rather than a list.
    const generation = name.match(/claude-(?:opus-|sonnet-|haiku-|fable-)?(\d+)(?:[.-](\d+))?/);
    const major = Number(generation?.[1] || 0);
    const minor = Number(generation?.[2] || 0);
    const thinks = major > 3 || (major === 3 && minor >= 7);
    return ["completion", "tools", "vision", ...(thinks ? ["thinking"] : [])];
  }
  if (providerId === "gemini") return ["completion", "tools", "vision", ...(/2\.5|3\./.test(name) ? ["thinking"] : [])];
  const configured = metadata.configuredCapabilities || {};
  return ["completion", ...(["tools", "vision", "thinking"].filter((item) => configured[item]))];
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

// Gemini's own listing is the primary filter. Requiring streamGenerateContent
// here would be wrong even though that is the call chat makes: Google lists
// gemini-2.5-pro as supporting generateContent only, and streaming works
// anyway, so the stricter test would empty the dropdown entirely.
const NOT_CHAT_GEMINI = /(^|[-/])(imagen|veo|aqa)|[-/](tts|embedding|image|live)(-|$)/i;

function chatCapable(providerId, item, id) {
  if (providerId === "ollama") return true;
  if (providerId === "gemini") {
    return Boolean(item.supportedGenerationMethods?.includes("generateContent"))
      && !NOT_CHAT_GEMINI.test(String(id));
  }
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

// Exported so the shape of an outbound request can be asserted directly. The
// alternative is discovering it from a provider's 400, which names a message
// index and nothing that maps back to a conversation.
// Only the knobs. A provider naming `messages` or `model` as unsupported is
// describing a different problem, and retrying without them would send a
// request that means something else.
const DROPPABLE_PARAMETERS = new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty"]);

// Which parameter a 400 is complaining about, read from the response without
// consuming it — the caller still needs the body to build its error.
export async function refusedParameter(response) {
  const payload = await response.clone().json().catch(() => ({}));
  const named = String(payload.error?.param || "").trim();
  if (DROPPABLE_PARAMETERS.has(named)) return named;
  const message = String(payload.error?.message || "");
  // OpenAI names it in quotes; other gateways paraphrase.
  const quoted = message.match(/'([a-z_]+)'/i)?.[1]
    || message.match(/parameter[: ]+([a-z_]+)/i)?.[1];
  return DROPPABLE_PARAMETERS.has(quoted) && /unsupported|not support|invalid/i.test(message) ? quoted : "";
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
export function toAnthropicMessages(messages = []) {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id || "", content: message.content || "" }]
      };
    }
    const content = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const image of message.images || []) {
      // Declared as what it is: both providers read the bytes and refuse an
      // image whose type does not match what it was called.
      content.push({ type: "image", source: { type: "base64", media_type: imageMediaType(image) || "image/jpeg", data: image } });
    }
    for (const call of message.tool_calls || []) {
      content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: toolArguments(call) });
    }
    return { role: message.role === "assistant" ? "assistant" : "user", content };
  // Anthropic rejects a message whose content array is empty. Nothing upstream
  // should produce one, and this is cheaper than finding out from a 400 that
  // names an index.
  }).filter((message) => message.content.length);
}

export function toGeminiContents(messages = []) {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: message.tool_name || "tool", response: { output: message.content || "" } } }]
      };
    }
    const parts = [];
    if (message.content) parts.push({ text: message.content });
    for (const image of message.images || []) {
      parts.push({ inlineData: { mimeType: imageMediaType(image) || "image/jpeg", data: image } });
    }
    for (const call of message.tool_calls || []) {
      // Gemini's thinking models return a thoughtSignature alongside each
      // functionCall, and refuse the conversation on the next turn if that
      // signature does not come back with the call — "Function call is missing a
      // thought_signature in functionCall parts". It is opaque and per-call, so
      // it is carried on the stored call and echoed here rather than
      // regenerated.
      const signature = call.providerMeta?.thoughtSignature;
      parts.push({
        functionCall: { name: call.function?.name, args: toolArguments(call) },
        ...(signature ? { thoughtSignature: signature } : {})
      });
    }
    return { role: message.role === "assistant" ? "model" : "user", parts };
  // Gemini rejects empty parts for the same reason Anthropic rejects empty
  // content.
  }).filter((message) => message.parts.length);
}

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

export function normalizeMessagesOpenAi(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", content: message.content, tool_call_id: message.tool_call_id || message.toolCallId || "" };
    }
    const output = { role: message.role, content: message.content || "" };
    // Length, not truthiness: an assistant turn that called no tools must omit
    // the field entirely rather than send an empty array, which is a 400.
    if (message.tool_calls?.length) {
      output.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function?.name,
          arguments: typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments || {})
        }
      }));
    }
    if (message.images?.length && message.role === "user") {
      output.content = [
        { type: "text", text: message.content || "" },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${imageMediaType(image) || "image/jpeg"};base64,${image}` }
        }))
      ];
    }
    return output;
  });
}

async function parseSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let warned = false;
  const emit = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      // One malformed event must not kill the whole stream.
      if (!warned) console.warn("Skipped a malformed provider stream event.");
      warned = true;
      return;
    }
    onEvent(parsed);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) emit(block);
    if (done) break;
  }
  if (buffer.trim()) emit(buffer);
}

function clampMaxTokens(value, fallback = 4096) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(256, Math.min(32_768, Math.round(parsed)));
}

// Model capabilities are immutable per (name, digest), so probe results are
// shared across profiles and survive list refreshes.
const ollamaCapabilityCache = new Map();

export function createProviderService({ database, secretStore, ollamaUrl, providerBaseUrls = {}, lookup = dns.lookup }) {
  const cache = new Map();

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
    // A hostname that passed the save-time check can later resolve somewhere
    // else, so re-check immediately before connecting rather than trusting the
    // stored URL. Only `custom` is user-supplied and internet-facing: the other
    // providers are fixed public hosts, and an Ollama endpoint is deliberately
    // allowed to be loopback or a LAN machine.
    if (providerId === "custom") await validateCustomBaseUrl(baseUrl, lookup);
    return {
      definition,
      saved,
      baseUrl,
      apiKey: saved?.encryptedSecret ? await secretStore.decrypt(saved.encryptedSecret) : ""
    };
  }

  async function providerFetch(providerId, route, options = {}) {
    const current = await config(providerId);
    let response;
    try {
      response = await fetch(`${current.baseUrl}${route}`, {
        ...options,
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...authHeaders(providerId, current.apiKey),
          ...(options.headers || {})
        }
      });
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
      throw providerError(unreachableMessage(providerId, current.baseUrl), 503, "PROVIDER_UNREACHABLE");
    }
    if (response.status >= 300 && response.status < 400) throw providerError("AI provider redirects are not allowed.", 502, "PROVIDER_REDIRECT");
    let rejectedCredential = response.status === 401 || response.status === 403;
    // Gemini commonly reports a revoked/invalid key as HTTP 400 rather than
    // 401. Inspect a clone so the original response remains readable by the
    // normal provider adapter.
    if (!rejectedCredential && providerId === "gemini" && response.status === 400) {
      const payload = await response.clone().json().catch(() => ({}));
      const reasons = (payload.error?.details || []).map((detail) => detail?.reason).filter(Boolean).join(" ");
      rejectedCredential = /API_KEY_INVALID/i.test(reasons)
        || /api key.{0,80}(invalid|revoked|expired|blocked)/i.test(String(payload.error?.message || ""));
    }
    if (rejectedCredential) {
      cache.delete(providerId);
      if (providerId !== "ollama" && credential(providerId)) {
        database.setProviderStatus(providerId, "error", "API key rejected or revoked. Replace the key to reconnect.");
      }
      // This is deliberately not HTTP 401: that status is reserved for the
      // local Evolv session and would otherwise send the renderer to login.
      throw providerError(`${current.definition.name} rejected its API key. Replace the key in Settings.`, 424, "PROVIDER_AUTH_FAILED");
    }
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
    } else if (providerId === "gemini") {
      const response = await providerFetch(providerId, "/models");
      if (!response.ok) throw await failedRequest("Gemini", "model list", response);
      result = (await response.json()).models?.filter((item) => chatCapable(providerId, item, item.name))
        .map((item) => toModel(providerId, item)) || [];
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
    if (providerId === "custom") baseUrl = await validateCustomBaseUrl(body.baseUrl, lookup);
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
    const capabilities = providerId === "custom" ? {
      tools: body.capabilities?.tools === true,
      vision: body.capabilities?.vision === true,
      thinking: body.capabilities?.thinking === true
    } : {};
    cache.delete(providerId);
    database.saveProviderCredential({ providerId, encryptedSecret, baseUrl, capabilities });
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

  async function streamOpenAiCompatible(providerId, payload, signal, onChunk) {
    const body = {
      model: payload.model,
      messages: normalizeMessagesOpenAi(payload.messages),
      tools: payload.tools,
      temperature: payload.options?.temperature,
      stream: true
    };
    const send = () => providerFetch(providerId, "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });

    // Checked before it goes, so a shape nobody imagined is named here rather
    // than arriving as an index into a request the person cannot see.
    const problems = reportRequestProblems(DEFINITIONS[providerId].name, inspectOpenAiRequest(body.messages));

    let response = await send();
    // Reasoning models accept only the default for the sampling parameters and
    // answer 400 naming the one they refuse:
    //   Unsupported value: 'temperature' does not support 0.9 with this model.
    // Keeping a list of which models those are is a list that goes stale the
    // day a model ships — and it already has, twice, elsewhere in this file. So
    // the refused parameter is dropped and the request made once more. The
    // model still answers; it just answers at its own default.
    if (!response.ok && response.status === 400) {
      const refused = await refusedParameter(response);
      if (refused && refused in body) {
        delete body[refused];
        response = await send();
      }
    }
    if (!response.ok) throw await failedRequest(DEFINITIONS[providerId].name, "chat", response, problems);
    const calls = new Map();
    await parseSse(response, (event) => {
      const delta = event.choices?.[0]?.delta || {};
      if (delta.content) onChunk({ message: { content: delta.content } });
      if (delta.reasoning_content || delta.reasoning) onChunk({ message: { thinking: delta.reasoning_content || delta.reasoning } });
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? call.id ?? 0;
        const current = calls.get(key) || { id: call.id || "", function: { name: "", arguments: "" } };
        current.id ||= call.id || "";
        current.function.name += call.function?.name || "";
        current.function.arguments += call.function?.arguments || "";
        calls.set(key, current);
      }
    });
    if (calls.size) onChunk({ message: { tool_calls: [...calls.values()] } });
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
    if (["openai", "openrouter", "custom"].includes(providerId)) {
      return streamOpenAiCompatible(providerId, payload, signal, onChunk);
    }
    // Anthropic and Gemini use a non-streaming compatibility bridge in v1;
    // the browser still receives normalized incremental events per content block.
    if (providerId === "anthropic") {
      const system = payload.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
      const messages = toAnthropicMessages(payload.messages);
      const problems = reportRequestProblems("Anthropic", inspectAnthropicRequest(messages));
      const response = await providerFetch(providerId, "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: payload.model, system, messages,
          max_tokens: clampMaxTokens(payload.options?.maxTokens),
          stream: true,
          temperature: payload.options?.temperature,
          tools: payload.tools?.map((tool) => ({
            name: tool.function.name, description: tool.function.description,
            input_schema: tool.function.parameters
          }))
        }),
        signal
      });
      if (!response.ok) throw await failedRequest("Anthropic", "chat", response, problems);
      // Native Messages SSE: text/thinking deltas stream through as they
      // arrive; tool_use inputs are assembled from input_json_delta events.
      const pendingCalls = new Map();
      await parseSse(response, (event) => {
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          pendingCalls.set(event.index, { id: event.content_block.id, name: event.content_block.name, partialJson: "" });
        } else if (event.type === "content_block_delta") {
          const delta = event.delta || {};
          if (delta.type === "text_delta" && delta.text) onChunk({ message: { content: delta.text } });
          if (delta.type === "thinking_delta" && delta.thinking) onChunk({ message: { thinking: delta.thinking } });
          if (delta.type === "input_json_delta") {
            const pending = pendingCalls.get(event.index);
            if (pending) pending.partialJson += delta.partial_json || "";
          }
        } else if (event.type === "content_block_stop") {
          const pending = pendingCalls.get(event.index);
          if (pending) {
            pendingCalls.delete(event.index);
            let args = {};
            try { args = JSON.parse(pending.partialJson || "{}"); } catch { /* leave empty on malformed input */ }
            onChunk({ message: { tool_calls: [{ id: pending.id, function: { name: pending.name, arguments: args } }] } });
          }
        } else if (event.type === "error") {
          throw providerError(event.error?.message || "Anthropic stream error.");
        }
      });
      return;
    }
    if (providerId === "gemini") {
      const contents = toGeminiContents(payload.messages);
      const problems = reportRequestProblems("Gemini", inspectGeminiRequest(contents));
      // Omitted rather than sent empty: a systemInstruction whose only part is
      // an empty string is a 400, and the calls Evolv makes for titles and
      // memory extraction carry no system message at all.
      const systemText = payload.messages.filter((message) => message.role === "system")
        .map((message) => message.content).filter(Boolean).join("\n\n");
      const systemInstruction = systemText ? { parts: [{ text: systemText }] } : undefined;
      const response = await providerFetch(providerId, `/models/${encodeURIComponent(payload.model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents, ...(systemInstruction ? { systemInstruction } : {}),
          generationConfig: {
            temperature: payload.options?.temperature,
            maxOutputTokens: clampMaxTokens(payload.options?.maxTokens)
          },
          tools: payload.tools?.length ? [{ functionDeclarations: payload.tools.map((tool) => ({
            name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters
          })) }] : undefined
        }),
        signal
      });
      if (!response.ok) throw await failedRequest("Gemini", "chat", response, problems);
      await parseSse(response, (event) => {
        for (const part of event.candidates?.[0]?.content?.parts || []) {
          if (part.text) onChunk({ message: { content: part.text } });
          if (part.functionCall) {
            onChunk({ message: { tool_calls: [{
              function: { name: part.functionCall.name, arguments: part.functionCall.args },
              // Opaque, and required back verbatim on the next turn. Anything a
              // provider needs echoed goes in providerMeta; every other adapter
              // reads only name, arguments and id, so it travels harmlessly.
              ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {})
            }] } });
          }
        }
      });
    }
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
