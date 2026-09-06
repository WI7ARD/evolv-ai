import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-db-"));
  const dataDir = path.join(root, "data");
  const database = createDatabase({
    dataDir,
    legacyStateFile: path.join(dataDir, "missing-state.json"),
    defaultPrompt: "Test prompt"
  });
  return { root, dataDir, database };
}

test("SQLite repository persists conversations and message status", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(database.integrityCheck(), true);
  const conversation = database.createConversation();
  const userId = database.addMessage({
    conversationId: conversation.id,
    role: "user",
    content: "Hello"
  });
  const assistantId = database.addMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "Par",
    status: "streaming"
  });
  database.updateMessage(assistantId, { content: "Partial", status: "interrupted" });
  database.autoTitleConversation(conversation.id, "A useful conversation title");
  const loaded = database.getConversation(conversation.id);
  assert.equal(loaded.title, "A useful conversation title");
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].id, userId);
  assert.equal(loaded.messages[1].content, "Partial");
  assert.equal(loaded.messages[1].status, "interrupted");
});

test("startup reconciliation closes records interrupted by an application restart", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const conversation = database.createConversation();
  const assistantId = database.addMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "Partial answer",
    status: "streaming",
    metadata: { provider: "ollama" }
  });
  database.createToolRun({
    id: "running-tool", conversationId: conversation.id, messageId: assistantId,
    toolName: "calculate", arguments: "{}", risk: "read", decision: "allowed", status: "running"
  });
  database.createRoutingEvent({
    id: "selected-route", conversationId: conversation.id, messageId: assistantId,
    providerId: "ollama", modelId: "test", requestedModel: "auto"
  });
  database.createEvaluationRun({ id: "running-evaluation", providerId: "ollama", modelId: "test" });

  const counts = database.reconcileAfterRestart();
  assert.deepEqual(counts, { messages: 1, toolRuns: 1, routingEvents: 1, evaluationRuns: 1 });
  const message = database.getConversation(conversation.id).messages.find((item) => item.id === assistantId);
  assert.equal(message.status, "interrupted");
  assert.equal(message.metadata.provider, "ollama");
  assert.equal(message.metadata.recovery.reason, "application-restarted");
  assert.equal(database.listToolRuns()[0].status, "failed");
  assert.match(database.listToolRuns()[0].error, /APPLICATION_RESTARTED/);
  assert.equal(database.listRoutingEvents()[0].status, "interrupted");
  assert.equal(database.getEvaluationRun("running-evaluation").status, "failed");
  assert.equal(database.reconcileAfterRestart().messages, 0, "reconciliation must be idempotent");
  const audit = database.raw.prepare("SELECT metadata_json FROM audit_events WHERE event_type = 'recovery.startup-reconciled'").get();
  assert.deepEqual(JSON.parse(audit.metadata_json), counts);
});

test("a requested baseline personality upgrade is versioned, activated, and reversible", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-prompt-upgrade-"));
  const dataDir = path.join(root, "data");
  const upgrade = {
    id: "v2-builder",
    fromPrompt: "Original prompt",
    prompt: "Commercial engineer prompt",
    summary: "Builder",
    rationale: "Requested personality upgrade"
  };
  let database = createDatabase({ dataDir, defaultPrompt: "Original prompt", baselineUpgrade: upgrade });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const state = database.getState();
  assert.equal(state.activeVersionId, "v2-builder");
  assert.equal(state.versions.find((version) => version.id === "v1").prompt, "Original prompt");
  assert.equal(state.versions.find((version) => version.id === "v2-builder").prompt, "Commercial engineer prompt");
  assert.equal(state.versions.filter((version) => version.id === "v2-builder").length, 1);
  database.setMeta("active_version_id", "v1");
  database.close();
  database = createDatabase({ dataDir, defaultPrompt: "Original prompt", baselineUpgrade: upgrade });
  assert.equal(database.getState().activeVersionId, "v1", "a user rollback must survive restart");
  assert.equal(database.getState().versions.filter((version) => version.id === "v2-builder").length, 1);
});

test("the one-time personality upgrade preserves an existing custom prompt version", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-custom-prompt-upgrade-"));
  const dataDir = path.join(root, "data");
  let database = createDatabase({ dataDir, defaultPrompt: "Original prompt" });
  const state = database.getState();
  state.versions.push({
    id: "v9-custom", number: 9, prompt: "My custom prompt", summary: "Custom", rationale: "", tests: [], source: "user", createdAt: new Date().toISOString()
  });
  state.activeVersionId = "v9-custom";
  database.saveState(state);
  database.close();
  database = createDatabase({
    dataDir,
    defaultPrompt: "Original prompt",
    baselineUpgrade: { id: "v10-builder", prompt: "Commercial engineer prompt" }
  });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const upgraded = database.getState();
  assert.equal(upgraded.activeVersionId, "v10-builder");
  assert.ok(upgraded.versions.some((version) => version.id === "v9-custom" && version.prompt === "My custom prompt"));
});

test("browser migration is transactional and idempotent", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const payload = {
    fingerprint: "browser-fixture-1",
    conversations: [{
      id: "legacy-chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer", model: "test-model" }
      ]
    }],
    current: [],
    settings: { model: "test-model", voiceRate: 1.4 }
  };
  const first = database.importBrowser(payload);
  const second = database.importBrowser(payload);
  assert.equal(first.imported, true);
  assert.equal(second.imported, false);
  assert.equal(database.getConversation("legacy-chat").messages.length, 2);
  assert.equal(database.getSettings().model, "test-model");
  assert.equal(database.getSettings().voiceRate, undefined);
});

test("legacy JSON is backed up and imported without modifying the source", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-legacy-"));
  const dataDir = path.join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
  const stateFile = path.join(dataDir, "state.json");
  const legacy = {
    activeVersionId: "v7",
    versions: [{
      id: "v7",
      number: 7,
      prompt: "Imported",
      summary: "Imported version",
      rationale: "",
      source: "legacy",
      createdAt: "2026-01-01T00:00:00.000Z"
    }],
    feedback: [],
    knowledge: [],
    architectureProposals: [],
    pendingProposal: null
  };
  const original = JSON.stringify(legacy, null, 2);
  await writeFile(stateFile, original);
  const database = createDatabase({ dataDir, legacyStateFile: stateFile, defaultPrompt: "Default" });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(database.getState().activeVersionId, "v7");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(stateFile, "utf8")), original);
  const backups = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(dataDir, "backups")));
  assert.ok(backups.some((name) => name.startsWith("state-") && name.endsWith(".json")));
});

test("portable export omits vectors and imports conversations non-destructively", async (t) => {
  const first = await fixture();
  const second = await fixture();
  t.after(async () => {
    first.database.close();
    second.database.close();
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  });
  const conversation = first.database.createConversation({ title: "Export me" });
  first.database.addMessage({ conversationId: conversation.id, role: "user", content: "Portable" });
  const state = first.database.getState();
  state.knowledge.push({
    id: "knowledge-1",
    title: "Vector record",
    domain: "Test",
    content: "Portable knowledge",
    embedding: [0.1, 0.2],
    embeddingModel: "test",
    embeddingStatus: "semantic",
    source: "test",
    createdAt: new Date().toISOString()
  });
  first.database.saveState(state);
  const exported = first.database.exportData();
  assert.equal("embedding" in exported.state.knowledge[0], false);
  second.database.importData(exported);
  assert.equal(second.database.getConversation(conversation.id).messages[0].content, "Portable");
  assert.ok(second.database.getState().knowledge.some((item) => item.id === "knowledge-1"));
});

test("backups are restorable and pass integrity checks", async (t) => {
  const { root, dataDir, database } = await fixture();
  let restored;
  t.after(async () => {
    restored?.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const conversation = database.createConversation({ title: "Backed up" });
  database.addMessage({ conversationId: conversation.id, role: "user", content: "Precious data" });
  const { file } = await database.backup("test");
  restored = createDatabase({
    dataDir: path.join(root, "restore"),
    defaultPrompt: "Test prompt",
    dbPath: path.join(dataDir, "backups", file)
  });
  assert.equal(restored.integrityCheck(), true);
  const recovered = restored.getConversation(conversation.id);
  assert.equal(recovered.title, "Backed up");
  assert.equal(recovered.messages[0].content, "Precious data");
});

test("export includes every conversation past the pagination cap", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 150; index += 1) {
    const conversation = database.createConversation({ title: `bulk-${index}` });
    database.addMessage({ conversationId: conversation.id, role: "user", content: `message ${index}` });
  }
  const exported = database.exportData();
  assert.equal(exported.conversations.length, 150);
  assert.ok(exported.conversations.every((conversation) => conversation.messages.length === 1));
});

test("a stale aggregate cannot destroy records written after it was read", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  // Two overlapping requests: both read the aggregate, then both write. This is
  // an ordinary second browser tab, and it used to cost the first writer its
  // record because saving replaced whole tables from a snapshot.
  const firstRequest = database.getState();
  const secondRequest = database.getState();

  database.addFeedback({
    id: "feedback-first", rating: "up", note: "from the first request",
    versionId: firstRequest.activeVersionId, createdAt: new Date().toISOString()
  });
  database.addKnowledge({
    id: "knowledge-first", title: "First", domain: "Test", content: "Written by the first request"
  });
  database.addArchitectureProposal({ id: "proposal-first", title: "First", request: "one" });

  // The second request still holds an aggregate from before any of that.
  database.addFeedback({
    id: "feedback-second", rating: "down", note: "from the second request",
    versionId: secondRequest.activeVersionId, createdAt: new Date().toISOString()
  });
  database.addKnowledge({
    id: "knowledge-second", title: "Second", domain: "Test", content: "Written by the second request"
  });
  database.addArchitectureProposal({ id: "proposal-second", title: "Second", request: "two" });

  const stored = database.getState();
  assert.deepEqual(stored.feedback.map((item) => item.id).sort(), ["feedback-first", "feedback-second"]);
  assert.deepEqual(stored.knowledge.map((item) => item.id).sort(), ["knowledge-first", "knowledge-second"]);
  assert.deepEqual(stored.architectureProposals.map((item) => item.id).sort(), ["proposal-first", "proposal-second"]);

  // Deleting is explicit and reports honestly against the database, not against
  // whatever the caller happened to have read earlier.
  assert.equal(database.deleteKnowledge("knowledge-first"), true);
  assert.equal(database.deleteKnowledge("knowledge-first"), false);
  assert.deepEqual(database.getState().knowledge.map((item) => item.id), ["knowledge-second"]);

  // And a bulk merge adds without removing what it never knew about.
  database.saveState({ ...firstRequest, knowledge: [{ id: "knowledge-merged", title: "Merged", domain: "Test", content: "From an import" }] });
  assert.deepEqual(
    database.getState().knowledge.map((item) => item.id).sort(),
    ["knowledge-merged", "knowledge-second"]
  );
});

test("bounded tables keep their newest records when the ceiling is reached", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < 6; index += 1) {
    database.addFeedback({
      id: `feedback-${index}`, rating: "up", note: `note ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }, { keep: 3 });
  }
  assert.deepEqual(database.getState().feedback.map((item) => item.id), ["feedback-3", "feedback-4", "feedback-5"]);
});

test("prompt versions are appended and promoted without rewriting the table", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const baseline = database.getState();
  assert.equal(baseline.activeVersionId, "v1");

  database.addPromptVersion({
    id: "v2-upgrade", number: 2, prompt: "Improved prompt", summary: "Upgrade",
    rationale: "Because", tests: [{ input: "a", expected: "b" }], source: "feedback-upgrade"
  });
  database.setActiveVersion("v2-upgrade");
  database.setPendingProposal(null);

  const stored = database.getState();
  assert.deepEqual(stored.versions.map((version) => version.id), ["v1", "v2-upgrade"]);
  assert.equal(stored.activeVersionId, "v2-upgrade");
  assert.equal(stored.pendingProposal, null);
  assert.deepEqual(stored.versions.at(-1).tests, [{ input: "a", expected: "b" }]);

  const proposal = { id: "proposal-1", prompt: "Draft", baseVersionId: "v2-upgrade" };
  database.setPendingProposal(proposal);
  assert.deepEqual(database.getState().pendingProposal, proposal);

  // Rolling back to an earlier version keeps every recorded version intact.
  database.setActiveVersion("v1");
  assert.equal(database.getState().activeVersionId, "v1");
  assert.equal(database.getState().versions.length, 2);
});
