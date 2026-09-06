const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
import { createAuthenticatedFetch } from "./authenticated-fetch.mjs";

const preferredModel = process.env.MODEL || "qwen3:4b";
const thinkValue = process.env.THINK === "false" ? false : (process.env.THINK || true);
const mode = process.env.MODE || "standard";
// SMOKE_PROMPT, not PROMPT: Windows exports PROMPT=$P$G globally, which would silently replace the test prompt.
const prompt = process.env.SMOKE_PROMPT || "Reply with exactly: EVOLV_OK";

const authenticatedFetch = await createAuthenticatedFetch(baseUrl);
const modelsResponse = await authenticatedFetch("/api/models");
if (!modelsResponse.ok) throw new Error(`Model discovery failed: ${modelsResponse.status}`);
const { models } = await modelsResponse.json();
const model = models.find((item) => item.name === preferredModel)?.name
  || models.find((item) => !item.family?.includes("bert"))?.name;
if (!model) throw new Error("No chat-capable Ollama model was found.");

const conversationResponse = await authenticatedFetch("/api/conversations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Smoke test" })
});
if (!conversationResponse.ok) throw new Error(`Could not create a conversation: ${await conversationResponse.text()}`);
const conversation = await conversationResponse.json();

try {
  const response = await authenticatedFetch(`/api/conversations/${conversation.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: prompt,
      model,
      think: thinkValue,
      mode,
      temperature: 0,
      numCtx: 4096
    })
  });
  if (!response.ok) throw new Error(`Chat failed: ${response.status} ${await response.text()}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    if (done) break;
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));

  const failure = events.find((event) => event.type === "error");
  if (failure) throw new Error(`${failure.code || "STREAM_ERROR"}: ${failure.message}`);
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  const thinking = events.filter((event) => event.type === "reasoning").map((event) => event.delta).join("");
  const metadata = events.find((event) => event.type === "metadata") || {};
  if (!content.trim()) throw new Error("The model stream completed without answer content.");

  console.log(JSON.stringify({
    ok: true,
    model,
    content: content.trim(),
    thinkingCharacters: thinking.length,
    mode: metadata.mode,
    knowledgeMatches: metadata.knowledge?.length || 0,
    eventCount: events.length
  }, null, 2));
} finally {
  // Keep repeated smoke runs from accumulating conversations in the trash.
  await authenticatedFetch(`/api/conversations/${conversation.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
}
