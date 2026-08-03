import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import {
  analyzeTask,
  scoreCandidate,
  selectAutoModel,
  sanitizeMemoryProposals,
  evaluationCaseFromFeedback,
  summarizeEvaluation,
  normalizeIntelligenceSettings
} from "../lib/intelligence.mjs";

test("project source sharing is cloud-denied by default and provider-specific when enabled", () => {
  assert.deepEqual(normalizeIntelligenceSettings({}).projectCloudProviders, []);
  assert.deepEqual(normalizeIntelligenceSettings({ projectCloudProviders: ["openai", "ollama", "openai", "unknown"] }).projectCloudProviders, ["openai"]);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-intelligence-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "test" });
  return { root, database };
}

test("task analysis and scoring enforce capability and balanced local preferences", () => {
  const simple = analyzeTask({ text: "Summarize this sentence." });
  const complex = analyzeTask({ text: "Analyze this architecture trade-off and plan an implementation.", mode: "cognitive", toolsEnabled: true });
  assert.equal(simple.simple, true);
  assert.ok(complex.complexity >= 3);
  const local = scoreCandidate({
    providerId: "ollama",
    model: { id: "local", parameterSize: "8B", capabilities: ["completion", "tools"] },
    task: simple
  });
  const cloud = scoreCandidate({
    providerId: "openai",
    model: { id: "cloud", capabilities: ["completion", "tools", "thinking"] },
    task: simple
  });
  assert.ok(local.score > cloud.score);
  assert.equal(scoreCandidate({ providerId: "ollama", model: { capabilities: [] }, task: { ...simple, requiresVision: true } }).eligible, false);
});

test("Auto routing never considers cloud providers without explicit opt-in", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.patchSettings({ intelligence: { autoCloudProviders: [] } });
  const calls = [];
  const providerService = {
    list: () => [{ id: "ollama", configured: true }, { id: "openai", configured: true }],
    models: async (provider) => {
      calls.push(provider);
      return provider === "ollama"
        ? [{ id: "local", capabilities: ["completion"], parameterSize: "8B" }]
        : [{ id: "cloud", capabilities: ["completion", "thinking"] }];
    }
  };
  const selected = await selectAutoModel({ providerService, database, text: "Hello", images: [], mode: "standard", toolsEnabled: false });
  assert.equal(selected.provider, "ollama");
  assert.deepEqual(calls, ["ollama"]);
});

test("Auto routing reports when provider discovery falls back to an available model", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.patchSettings({ intelligence: { autoCloudProviders: ["openai"] } });
  const providerService = {
    list: () => [{ id: "ollama", configured: true }, { id: "openai", configured: true }],
    models: async (provider) => {
      if (provider === "openai") throw new Error("API key revoked");
      return [{ id: "local", capabilities: ["completion"], parameterSize: "8B" }];
    }
  };
  const selected = await selectAutoModel({ providerService, database, text: "Hello", images: [], mode: "standard", toolsEnabled: false });
  assert.equal(selected.model, "local");
  assert.equal(selected.fallback.used, true);
  assert.match(selected.fallback.message, /openai/);
  assert.deepEqual(selected.fallback.unavailableProviders.map((item) => item.provider), ["openai"]);
});

test("Auto enforces the cloud cost-unit safeguard before sending a prompt", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.patchSettings({ intelligence: { autoCloudProviders: ["openai"], monthlyCostLimit: 2 } });
  const providerService = {
    list: () => [{ id: "ollama", configured: true }, { id: "openai", configured: true }],
    models: async (provider) => provider === "ollama"
      ? [{ id: "local", capabilities: ["completion"] }]
      : [{ id: "vision-cloud", capabilities: ["completion", "vision"] }]
  };
  await assert.rejects(
    selectAutoModel({ providerService, database, text: "Describe this", images: ["image"], mode: "standard", toolsEnabled: false }),
    (error) => error.code === "AUTO_CLOUD_BUDGET_REACHED"
  );
});

test("memory proposals deduplicate creates and turn changed titles into updates", () => {
  const existing = [{ id: "m1", type: "preference", title: "Writing style", body: "Be concise", status: "active" }];
  const proposals = sanitizeMemoryProposals({ proposals: [
    { action: "create", type: "preference", title: "Writing style", body: "Be concise", rationale: "same", confidence: 1 },
    { action: "create", type: "preference", title: "Writing style", body: "Use concise examples", rationale: "changed", confidence: .9 }
  ] }, existing);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].action, "update");
  assert.equal(proposals[0].targetId, "m1");
});

test("feedback cases and blind summaries require a real win without regressions", () => {
  const item = evaluationCaseFromFeedback({ id: "f1", rating: "down", note: "Too vague", userMessage: "Explain it", assistantMessage: "Maybe", model: "test" });
  assert.equal(item.feedbackId, "f1");
  assert.match(item.failureReason, /vague/);
  assert.equal(summarizeEvaluation([{ winner: "B", criticalRegression: false }]).recommended, true);
  assert.equal(summarizeEvaluation([{ winner: "B", criticalRegression: true }]).recommended, false);
});

test("intelligence records persist and memory approval is the only activation path", async (t) => {
  const { root, database } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const conversation = database.createConversation();
  const messageId = database.addMessage({ conversationId: conversation.id, role: "assistant", content: "done" });
  database.saveModelPreference("ollama", "qwen", { quality: 5, cost: 0, enabledAuto: true });
  const routeId = database.createRoutingEvent({
    conversationId: conversation.id, messageId, providerId: "ollama", modelId: "qwen",
    requestedModel: "auto", task: { simple: true }, reasons: ["local"], considered: [], score: 20, cloud: false
  });
  database.finishRoutingEvent(routeId, { status: "complete" });
  const proposal = database.addMemoryProposal({
    conversationId: conversation.id, sourceMessageId: messageId, action: "create", type: "decision",
    title: "Private build", body: "Keep the personal version separate.", confidence: .95
  });
  assert.equal(database.listMemoryNodes().length, 0);
  database.reviewMemoryProposal(proposal.id, "approved");
  assert.equal(database.listMemoryNodes().length, 1);
  assert.equal(database.listRoutingEvents()[0].status, "complete");
  assert.equal(database.listModelPreferences()[0].quality, 5);
  const exported = JSON.stringify(database.exportData());
  assert.match(exported, /modelPreferences/);
  assert.doesNotMatch(exported, /encryptedSecret|recoveryHash|passwordHash/);
});
