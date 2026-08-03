const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
import { createAuthenticatedFetch } from "./authenticated-fetch.mjs";

const model = process.env.MODEL || "qwen3:4b";
// SMOKE_PROMPT, not PROMPT: Windows exports PROMPT=$P$G globally, which would silently replace the test prompt.
const prompt = process.env.SMOKE_PROMPT || "Use the calculator tool to calculate (11434+12341)*412. You must use the tool.";

const authenticatedFetch = await createAuthenticatedFetch(baseUrl);
const conversationResponse = await authenticatedFetch("/api/conversations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Persisted smoke test" })
});
if (!conversationResponse.ok) throw new Error(await conversationResponse.text());
const conversation = await conversationResponse.json();

try {
  const response = await authenticatedFetch(`/api/conversations/${conversation.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: prompt,
      model,
      mode: "cognitive",
      think: false,
      temperature: 0,
      numCtx: 8192
    })
  });
  if (!response.ok) throw new Error(await response.text());
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
  const loaded = await (await authenticatedFetch(`/api/conversations/${conversation.id}`)).json();
  const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
  const requests = events.filter((event) => event.type === "tool_request");
  const results = events.filter((event) => event.type === "tool_result");
  const completed = events.findLast((event) => event.type === "complete");
  if (!content.trim()) throw new Error("No final content was streamed.");
  if (!completed) throw new Error("No completion event was streamed.");
  if (!loaded.messages.some((message) => message.role === "assistant")) throw new Error("Assistant response was not persisted.");
  console.log(JSON.stringify({
    ok: true,
    model,
    conversationId: conversation.id,
    toolRequests: requests.map((event) => event.tool),
    toolResults: results.map((event) => event.status),
    finalStatus: completed.status,
    persistedMessages: loaded.messages.length,
    content: content.trim()
  }, null, 2));
} finally {
  await authenticatedFetch(`/api/conversations/${conversation.id}?permanent=true`, { method: "DELETE" });
}
