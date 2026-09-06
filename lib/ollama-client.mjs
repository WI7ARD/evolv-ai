// A small typed client for the parts of the Ollama HTTP API Evolv drives
// directly: which models exist, and building one.
//
// Chat and embeddings do not come through here — those belong to the provider
// service, which has its own streaming, capability cache and error mapping.
// This is the model-management half, and keeping it separate is what stops a
// second provider system from growing next to the first one.
import { buildModelfile } from "./evolv-models.mjs";

function ollamaError(message, { status = 503, code = "OLLAMA_UNREACHABLE", cause } = {}) {
  return Object.assign(new Error(message), { status, code, cause, expose: true });
}

// Every line Ollama streams is a complete JSON object. Chunks arrive split
// anywhere, including mid-character, so the decoder is stateful and the tail is
// carried between reads.
export async function* readNdjson(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
      index = buffer.indexOf("\n");
    }
  }
  const last = buffer.trim();
  if (last) yield JSON.parse(last);
}

export function createOllamaClient({ baseUrl, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const origin = String(baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");

  async function request(route, { method = "GET", body, signal, timeout = timeoutMs } = {}) {
    // A pull has no useful overall deadline — a slow connection is not a broken
    // one — so a download passes timeout: 0 and relies on the caller's signal.
    const timeoutSignal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
    const composed = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal || timeoutSignal);
    let response;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: composed || undefined
      });
    } catch (error) {
      // A cancelled install is the user's decision, not a fault to translate.
      if (error?.name === "AbortError" && signal?.aborted) throw error;
      throw ollamaError("Ollama stopped responding. Start Ollama and try again.", { cause: error });
    }
    return response;
  }

  async function json(route, options) {
    const response = await request(route, options);
    if (!response.ok) {
      throw ollamaError(`Ollama returned ${response.status} for ${route}.`, {
        status: 502, code: "OLLAMA_REQUEST_FAILED"
      });
    }
    return response.json();
  }

  // Streams an NDJSON endpoint, handing every event to `onEvent`. Ollama
  // reports failure in the body of a 200 as often as in the status code, so
  // both are checked.
  async function stream(route, body, { signal, onEvent } = {}) {
    const response = await request(route, { method: "POST", body, signal, timeout: 0 });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw ollamaError(detail.trim() || `Ollama returned ${response.status} for ${route}.`, {
        status: 502, code: "OLLAMA_REQUEST_FAILED"
      });
    }
    for await (const event of readNdjson(response)) {
      if (event.error) throw ollamaError(String(event.error), { status: 502, code: "OLLAMA_STREAM_ERROR" });
      onEvent?.(event);
    }
  }

  return {
    baseUrl: origin,

    async version() {
      return (await json("/api/version")).version || "";
    },

    // Ollama calls the field `name` in older builds and `model` in newer ones.
    async listModels() {
      const payload = await json("/api/tags");
      return (payload.models || []).map((item) => ({
        name: item.name || item.model || "",
        size: Number(item.size) || 0,
        digest: item.digest || "",
        parameterSize: item.details?.parameter_size || ""
      })).filter((item) => item.name);
    },

    // What a built model actually contains. Evolv reads the system prompt back
    // to tell a model built from the current prompt from one built before it
    // changed.
    async show(model) {
      const response = await request("/api/show", { method: "POST", body: { model } });
      if (!response.ok) return null;
      return response.json();
    },

    async pull(model, { signal, onEvent } = {}) {
      await stream("/api/pull", { model, stream: true }, { signal, onEvent });
    },

    // Newer Ollama takes the pieces apart; older builds only understand a
    // Modelfile. The structured form is tried first and the older one is the
    // fallback, so this works either side of that change.
    async create(name, definition, { signal, onEvent } = {}) {
      try {
        await stream("/api/create", {
          model: name,
          from: definition.base,
          system: definition.system,
          parameters: definition.parameters,
          stream: true
        }, { signal, onEvent });
      } catch (error) {
        if (error.code !== "OLLAMA_REQUEST_FAILED" && error.code !== "OLLAMA_STREAM_ERROR") throw error;
        await stream("/api/create", {
          model: name,
          modelfile: buildModelfile(definition),
          stream: true
        }, { signal, onEvent });
      }
    }
  };
}
