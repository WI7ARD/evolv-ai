import crypto from "node:crypto";
import { finish, normalizeToolArguments, providerState, reasoningDelta, textDelta, toolCall, usage } from "./ai-events.mjs";
import { imageMediaType } from "./images.mjs";
import { parseSse } from "./sse.mjs";

function systemInstruction(messages = []) {
  return messages.filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim()).filter(Boolean).join("\n\n");
}

function rawGeminiSteps(message) {
  return (message.provider_state || message.providerState || [])
    .map((state) => state?.geminiStep)
    .filter((step) => step && typeof step === "object");
}

export function toGeminiInteractionInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const rawSteps = rawGeminiSteps(message);
      if (rawSteps.length) {
        input.push(...rawSteps);
        continue;
      }
      if (message.content) input.push({ type: "model_output", content: [{ type: "text", text: String(message.content) }] });
      for (const call of message.tool_calls || []) {
        input.push(call.providerState?.geminiStep || {
          type: "function_call",
          id: call.id,
          call_id: call.id,
          name: call.function?.name || "",
          arguments: normalizeToolArguments(call.function?.arguments)
        });
      }
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_result",
        call_id: message.tool_call_id || message.toolCallId || "",
        name: message.tool_name || "tool",
        result: [{ type: "text", text: String(message.content || "") }]
      });
      continue;
    }
    const content = [];
    if (message.content) content.push({ type: "text", text: String(message.content) });
    for (const image of message.images || []) {
      content.push({ type: "image", mime_type: imageMediaType(image) || "image/jpeg", data: image });
    }
    if (content.length) input.push({ type: "user_input", content });
  }
  return input;
}

function thinkingLevel(value) {
  if (value === false || value === "none") return "minimal";
  if (value === true) return "medium";
  const normalized = String(value || "").toLowerCase();
  return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : "";
}

export function buildGeminiInteractionRequest(payload = {}) {
  const instruction = systemInstruction(payload.messages);
  const tools = payload.tools?.map((tool) => ({
    type: "function",
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || "",
    parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} }
  }));
  const level = thinkingLevel(payload.think);
  const maxTokens = Number(payload.options?.maxTokens);
  return {
    model: payload.model,
    input: toGeminiInteractionInput(payload.messages),
    ...(instruction ? { system_instruction: instruction } : {}),
    ...(tools?.length ? { tools } : {}),
    ...((level || Number.isFinite(maxTokens)) ? {
      generation_config: {
        ...(level ? { thinking_level: level } : {}),
        ...(level && level !== "minimal" ? { thinking_summaries: "auto" } : {}),
        ...(Number.isFinite(maxTokens) ? { max_output_tokens: Math.max(256, Math.min(32_768, Math.round(maxTokens))) } : {})
      }
    } : {}),
    ...(payload.format ? { response_format: { type: "text", mime_type: "application/json", schema: payload.format } } : {}),
    store: false,
    stream: true
  };
}

function eventType(event) {
  return event?.event_type || event?.type || event?._event || "";
}

function stepType(step) {
  return step?.type || step?.step_type || "";
}

export async function streamGeminiInteraction({ payload, signal, request, onEvent }) {
  const body = buildGeminiInteractionRequest(payload);
  const response = await request("/interactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    retryTransient: true
  });
  if (!response.ok) return { response, body };

  const steps = new Map();
  const emitted = new Set();
  await parseSse(response, (event) => {
    const type = eventType(event);
    if (type === "step.start") {
      const step = structuredClone(event.step || event.item || {});
      steps.set(event.index ?? event.step_id ?? step.id ?? steps.size, step);
    } else if (type === "step.delta") {
      const delta = event.delta || {};
      const key = event.index ?? event.step_id ?? event.id;
      const current = steps.get(key) || { id: key, type: event.step_type || "" };
      const kind = delta.type || event.delta_type || "";
      if ((kind === "text" || kind === "text_delta") && (delta.text || event.text)) {
        const text = String(delta.text || event.text);
        onEvent(textDelta(text));
        current.type ||= "model_output";
        const existing = current.content?.[0]?.text || "";
        current.content = [{ type: "text", text: `${existing}${text}` }];
        steps.set(key, current);
      } else if ((kind === "thought" || kind === "thought_delta" || kind === "reasoning") && (delta.text || delta.thought || event.text)) {
        const text = String(delta.text || delta.thought || event.text);
        onEvent(reasoningDelta(text));
        const summary = current.summary?.[0]?.text || "";
        current.summary = [{ type: "text", text: `${summary}${text}` }];
        if (delta.signature || event.signature) current.signature = delta.signature || event.signature;
        steps.set(key, current);
      } else if (kind === "arguments" || kind === "arguments_delta" || event.arguments_delta) {
        current.arguments = `${current.arguments || ""}${delta.partial_arguments || delta.arguments_delta || delta.text || event.arguments_delta || ""}`;
        steps.set(key, current);
      }
    } else if (type === "step.stop") {
      const key = event.index ?? event.step_id ?? event.id;
      const step = { ...(steps.get(key) || {}), ...(event.step || event.item || {}) };
      if (event.signature && !step.signature) step.signature = event.signature;
      if (stepType(step) === "function_call") step.arguments = normalizeToolArguments(step.arguments);
      if (!["user_input", "function_result"].includes(stepType(step))) {
        onEvent(providerState("gemini", { geminiStep: step }));
      }
      if (stepType(step) === "function_call") {
        const callId = step.call_id || step.id || crypto.randomUUID();
        emitted.add(callId);
        onEvent(toolCall({
          id: callId,
          name: step.name || step.function?.name,
          arguments: step.arguments ?? step.function?.arguments,
          providerState: { provider: "gemini", geminiStep: step }
        }));
      }
    } else if (type === "interaction.completed") {
      if (event.interaction?.usage || event.usage) onEvent(usage(event.interaction?.usage || event.usage));
      onEvent(finish(event.interaction?.status || "completed"));
    } else if (type === "interaction.failed" || type === "error") {
      const message = event.error?.message || event.interaction?.error?.message || "Gemini interaction stream failed.";
      throw Object.assign(new Error(message), { code: "PROVIDER_STREAM_ERROR", status: 502, expose: true });
    }
  });
  return { response, body };
}
