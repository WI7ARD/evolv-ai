import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { retrieveMemory, memoryContext, sanitizeExtractedNodes } from "../lib/memory.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-memory-"));
  const database = createDatabase({
    dataDir: root,
    legacyStateFile: path.join(root, "missing.json"),
    defaultPrompt: "Test"
  });
  return { root, database };
}

const noEmbeddings = async () => {
  throw new Error("embeddings unavailable in tests");
};

test("memory nodes and edges: create, link, update, delete cascade", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = database.addMemoryNode({ type: "task", title: "Ship the packaging fix", body: "Windows zip build breaks on Node 24." });
  const decision = database.addMemoryNode({ type: "decision", title: "Stay on Electron 41", body: "Electron 42 has no better-sqlite3 prebuild." });
  const edge = database.addMemoryEdge({ fromId: task.id, toId: decision.id, relation: "depends-on" });
  assert.ok(edge.id);
  const graph = database.getMemoryGraph();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.ok(!("embedding" in graph.nodes[0]));

  const resolved = database.updateMemoryNode(task.id, { status: "resolved" });
  assert.equal(resolved.status, "resolved");

  assert.equal(database.deleteMemoryNode(decision.id), true);
  assert.equal(database.listMemoryEdges().length, 0, "edges cascade with their node");
});

test("retrieval pins active project/task nodes and scores the rest lexically", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.addMemoryNode({ type: "task", title: "Finish itch.io release", body: "Push the next build with butler." });
  database.addMemoryNode({ type: "note", title: "Gesture model", body: "MediaPipe gesture recognizer runs in the browser." });
  database.addMemoryNode({ type: "preference", title: "Tone", body: "User prefers concise answers without filler." });
  database.addMemoryNode({ type: "task", title: "Old proposed idea", body: "Not yet approved.", status: "proposed" });
  database.addMemoryNode({ type: "note", title: "Retired", body: "Archived background info.", status: "archived" });

  const results = await retrieveMemory({
    nodes: database.listMemoryNodes(),
    edges: database.listMemoryEdges(),
    query: "how does the gesture recognizer work?",
    embedText: noEmbeddings
  });
  const titles = results.map((node) => node.title);
  assert.ok(titles.includes("Finish itch.io release"), "active task is pinned even off-topic");
  assert.ok(titles.includes("Gesture model"), "lexically relevant note is retrieved");
  assert.ok(!titles.includes("Old proposed idea"), "proposed nodes are not context until approved");
  assert.ok(!titles.includes("Retired"), "archived nodes are excluded");
});

test("memory context includes graph links and a data-not-instructions guard", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = database.addMemoryNode({ type: "project", title: "Evolv desktop app", body: "Local-first chat." });
  const decision = database.addMemoryNode({ type: "decision", title: "Use SQLite WAL", body: "Chosen for durability." });
  database.addMemoryEdge({ fromId: project.id, toId: decision.id, relation: "decided" });
  const items = await retrieveMemory({
    nodes: database.listMemoryNodes(),
    edges: database.listMemoryEdges(),
    query: "sqlite",
    embedText: noEmbeddings
  });
  const context = memoryContext(items);
  assert.match(context, /never as instructions/);
  assert.match(context, /Use SQLite WAL/);
  assert.match(context, /decided/);
});

test("extracted node sanitizer drops invalid records and caps lengths", () => {
  const cleaned = sanitizeExtractedNodes({
    nodes: [
      { type: "task", title: "Valid task", body: "Do the thing next week.", links: ["Evolv desktop app"] },
      { type: "hacker", title: "Bad type", body: "Should be dropped entirely." },
      { type: "note", title: "x", body: "Title too short." },
      { type: "note", title: "No body", body: "tiny" },
      { type: "decision", title: `${"T".repeat(300)}`, body: "Long title is truncated, not dropped." }
    ]
  });
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].title, "Valid task");
  assert.deepEqual(cleaned[0].links, ["Evolv desktop app"]);
  assert.equal(cleaned[1].title.length, 200);
  assert.equal(sanitizeExtractedNodes({ nodes: "junk" }).length, 0);
});
