// Runs a short persisted chat against every installed (non-embedding) model
// and prints a pass/fail table. Requires the Evolv server and Ollama running.
import { createAuthenticatedFetch } from "./authenticated-fetch.mjs";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const only = (process.env.MODELS || "").split(",").map((name) => name.trim()).filter(Boolean);

// Free the previous model's memory so each model is tested without contention.
async function unloadModel(name) {
  await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 })
  }).catch(() => {});
}

const authenticatedFetch = await createAuthenticatedFetch(baseUrl);
const { models } = await (await authenticatedFetch("/api/models")).json();
const targets = models.filter((model) => !only.length || only.includes(model.name));
if (!targets.length) {
  console.error("No chat-capable models found.");
  process.exit(1);
}

const results = [];

for (const model of targets) {
  const hasTools = model.capabilities.includes("tools");
  const prompt = hasTools
    ? "What is (11434+12341)*412? Use the calculator tool, then state only the numeric result."
    : "What is 7*8? Reply with just the number.";
  const started = Date.now();
  const row = { model: model.name, tools: hasTools, status: "fail", toolUsed: "", seconds: 0, note: "" };
  let conversation;
  try {
    conversation = await (await authenticatedFetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `models-smoke ${model.name}` })
    })).json();
    const response = await authenticatedFetch(`/api/conversations/${conversation.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: prompt, model: model.name, think: false, temperature: 0, numCtx: 4096 }),
      signal: AbortSignal.timeout(600_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) events.push(JSON.parse(buffer));

    const content = events.filter((event) => event.type === "content").map((event) => event.delta).join("");
    const complete = events.findLast((event) => event.type === "complete");
    const toolRequests = events.filter((event) => event.type === "tool_request").map((event) => event.tool);
    if (!content.trim()) throw new Error("no content streamed");
    if (!complete || complete.status !== "complete") throw new Error(`final status ${complete?.status || "missing"}`);
    if (content.includes("</think>") || content.includes("<think>")) throw new Error("think tags leaked into content");
    row.status = "pass";
    row.toolUsed = toolRequests.join(",") || "-";
    row.note = content.replace(/\s+/g, " ").trim().slice(0, 60);
  } catch (error) {
    row.note = error.message.slice(0, 80);
  } finally {
    row.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    if (conversation?.id) {
      await authenticatedFetch(`/api/conversations/${conversation.id}?permanent=true`, { method: "DELETE" }).catch(() => {});
    }
    await unloadModel(model.name);
  }
  results.push(row);
  console.log(`${row.status === "pass" ? "PASS" : "FAIL"}  ${row.model}  (${row.seconds}s)${row.toolUsed && row.toolUsed !== "-" ? `  tool: ${row.toolUsed}` : ""}${row.status === "fail" ? `  — ${row.note}` : ""}`);
}

console.log(`\n${"MODEL".padEnd(26)}${"RESULT".padEnd(8)}${"TOOLS".padEnd(7)}${"TIME".padEnd(8)}NOTE`);
for (const row of results) {
  console.log(`${row.model.padEnd(26)}${row.status.padEnd(8)}${(row.tools ? "yes" : "no").padEnd(7)}${`${row.seconds}s`.padEnd(8)}${row.note}`);
}
const failed = results.filter((row) => row.status !== "pass");
console.log(`\n${results.length - failed.length}/${results.length} models passed.`);
process.exit(failed.length ? 1 : 0);
