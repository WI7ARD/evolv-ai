import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { ApprovalService } from "../lib/approvals.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-approvals-"));
  const database = createDatabase({ dataDir: root, legacyStateFile: path.join(root, "missing.json"), defaultPrompt: "Test" });
  return { root, database, approvals: new ApprovalService(database) };
}

test("approval envelopes are idempotent, auditable, and execution is separate from authorization", async (t) => {
  const { root, database, approvals } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.createToolRun({ id: "run-1", conversationId: null, messageId: null, toolName: "propose_workspace_edit", arguments: "{}", risk: "approval-write", decision: "approval-required", status: "pending-approval" });
  const first = approvals.create({
    kind: "workspace-edit", resourceType: "engineering-action", resourceId: "action-1", toolRunId: "run-1",
    summary: "Change a project file", before: { sha256: "old" }, after: { sha256: "new" }
  });
  const duplicate = approvals.create({
    kind: "workspace-edit", resourceType: "engineering-action", resourceId: "action-2", toolRunId: "run-1"
  });
  assert.equal(duplicate.id, first.id);
  const authorized = approvals.decide(first.id, "approved");
  assert.equal(authorized.status, "approved");
  assert.equal(authorized.executedAt, null, "authorization must not claim that the effect executed");
  const executed = approvals.markExecuted(first.id, { sha256: "new" });
  assert.ok(executed.executedAt);
  assert.deepEqual(executed.result, { sha256: "new" });
  assert.ok(database.raw.prepare("SELECT COUNT(*) count FROM audit_events WHERE event_type LIKE 'approval.%'").get().count >= 2);
});

test("delegated macro approvals resolve to their specialized effect and rejection stays non-executing", async (t) => {
  const { root, database, approvals } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const inner = approvals.create({ kind: "obsidian-edit", resourceType: "obsidian-change", resourceId: "change-1" });
  const outer = approvals.create({
    kind: "tool-macro-effect", resourceType: "tool-macro-run", resourceId: "macro-run-1",
    metadata: { delegateApprovalId: inner.id }
  });
  assert.equal(approvals.resolve(outer).id, inner.id);
  const rejected = approvals.decide(outer.id, "rejected");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.executedAt, null);
});
