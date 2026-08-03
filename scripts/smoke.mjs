const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
import { createAuthenticatedFetch } from "./authenticated-fetch.mjs";

const preferredModel = process.env.MODEL || "qwen3:4b";
const thinkValue = process.env.THINK === "false" ? false : (process.env.THINK || true);
const mode = process.env.MODE || "standard";
const prompt = process.env.SMOKE_PROMPT || "Reply with exactly: EVOLV_OK";

const authenticatedFetch = await createAuthenticatedFetch(baseUrl);
const modelsResponse = await authenticatedFetch("/api/models");
if (!modelsResponse.ok) throw new Error(`Model discovery failed: ${modelsResponse.status}`);
const { models } = await modelsResponse.json();
const model = models.find((item) => item.name === preferredModel)?.name
  || models.find((item) => !item.family?.includes("bert"))?.name;
if (!model) throw new Error("No chat-capable Ollama model was found.");

const response = await authenticatedFetch("/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    think: thinkValue,
    mode,
    temperature: 0,
    numCtx: 4096,
    messages: [{ role: "user", content: prompt }]
  })
});
if (!response.ok) throw new Error(`Chat failed: ${response.status} ${await response.text()}`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let content = "";
let thinking = "";
let metadata = null;
let chunkCount = 0;
while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (chunk.meta) {
      metadata = chunk.meta;
      chunkCount += 1;
      continue;
    }
    content += chunk.message?.content || "";
    thinking += chunk.message?.thinking || "";
    chunkCount += 1;
  }
  if (done) break;
}

if (!content.trim()) throw new Error("The model stream completed without answer content.");
console.log(JSON.stringify({
  ok: true,
  model,
  content: content.trim(),
  thinkingCharacters: thinking.length,
  mode: metadata?.mode,
  knowledgeMatches: metadata?.knowledge?.length || 0,
  chunkCount
}, null, 2));
