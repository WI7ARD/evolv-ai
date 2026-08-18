import crypto from "node:crypto";
import { finish, providerState, reasoningDelta, textDelta, toolCall, usage } from "./ai-events.mjs";
import { imageMediaType } from "./images.mjs";
import { parseSse } from "./sse.mjs";

function systemInstructions(messages = []) {
  return messages.filter((message) => message.role === "system")
    .map((message) => String(message.content || "").trim()).filter(Boolean).join("\n\n");
}

function rawOpenAiItems(message) {
  return (message.provider_state || message.providerState || [])
    .map((state) => state?.openaiItem)
    .filter((item) => item && typeof item === "object");
}

export function toOpenAiResponsesInput(messages = []) {
  const input = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const rawItems = rawOpenAiItems(message);
      if (rawItems.length) {
        input.push(...rawItems);
        continue;
      }
      if (message.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: String(message.content) }] });
      }
      for (const call of message.tool_calls || []) {
        const raw = call.providerState?.openaiItem;
        input.push(raw || {
          type: "function_call",
          call_id: call.id,
          name: call.function?.name || "",
          arguments: typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments || {})
        });
      }
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || message.toolCallId || "",
        output: String(message.content || "")
      });
      continue;
    }
    const content = [];
    if (message.content) content.push({ type: "input_text", text: String(message.content) });
    for (const image of message.images || []) {
      content.push({ type: "input_image", image_url: `data:${imageMediaType(image) || "image/jpeg"};base64,${image}` });
    }
    if (content.length) input.push({ role: "user", content });
  }
  return input;
}

function reasoningEffort(value) {
  if (value === false || value === "none") return "none";
  if (value === true) return "medium";
  const normalized = String(value || "").toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "";
}

export function buildOpenAiResponsesRequest(payload = {}) {
  const instructions = systemInstructions(payload.messages);
  const tools = payload.tools?.map((tool) => ({
    type: "function",
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || "",
    parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
    strict: false
  }));
  const effort = reasoningEffort(payload.think);
  const maxTokens = Number(payload.options?.maxTokens);
  return {
    model: payload.model,
    ...(instructions ? { instructions } : {}),
    input: toOpenAiResponsesInput(payload.messages),
    ...(tools?.length ? { tools } : {}),
    ...(payload.format ? { text: { format: { type: "json_schema", name: "evolv_response", strict: true, schema: payload.format } } } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(Number.isFinite(maxTokens) ? { max_output_tokens: Math.max(256, Math.min(32_768, Math.round(maxTokens))) } : {}),
    store: false,
    stream: true
  };
}

function eventType(event) {
  return event?.type || event?._event || "";
}

export async function streamOpenAiResponses({ payload, signal, request, onEvent }) {
  const body = buildOpenAiResponsesRequest(payload);
  const response = await request("/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    retryTransient: true
  });
  if (!response.ok) return { response, body };

  const items = new Map();
  await parseSse(response, (event) => {
    const type = eventType(event);
    if (type === "response.output_text.delta" && event.delta) onEvent(textDelta(String(event.delta)));
    else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && event.delta) {
      onEvent(reasoningDelta(String(event.delta)));
    } else if (type === "response.output_item.added" && event.item) {
      items.set(event.output_index ?? event.item.id ?? items.size, structuredClone(event.item));
    } else if (type === "response.function_call_arguments.delta") {
      const key = event.output_index ?? event.item_id;
      const current = items.get(key) || { type: "function_call", id: event.item_id, call_id: event.call_id, name: event.name, arguments: "" };
      current.arguments = `${current.arguments || ""}${event.delta || ""}`;
      items.set(key, current);
    } else if (type === "response.output_item.done" && event.item) {
      const item = event.item;
      onEvent(providerState("openai", { openaiItem: item }));
      if (item.type === "function_call") {
        const callId = item.call_id || item.id || crypto.randomUUID();
        onEvent(toolCall({
          id: callId,
          name: item.name,
          arguments: item.arguments,
          providerState: { provider: "openai", openaiItem: item }
        }));
      }
    } else if (type === "response.function_call_arguments.done") {
      const key = event.output_index ?? event.item_id;
      const current = items.get(key) || { type: "function_call", id: event.item_id };
      current.name ||= event.name || "";
      current.arguments = event.arguments || current.arguments || "{}";
      items.set(key, current);
    } else if (type === "response.completed") {
      if (event.response?.usage) onEvent(usage(event.response.usage));
      onEvent(finish(event.response?.status || "completed"));
    } else if (type === "response.incomplete") {
      if (event.response?.usage) onEvent(usage(event.response.usage));
      onEvent(finish(event.response?.incomplete_details?.reason || "incomplete"));
    } else if (type === "response.failed" || type === "error") {
      const message = event.error?.message || event.response?.error?.message || "OpenAI response stream failed.";
      throw Object.assign(new Error(message), { code: "PROVIDER_STREAM_ERROR", status: 502, expose: true });
    }
  });
  return { response, body };
}
