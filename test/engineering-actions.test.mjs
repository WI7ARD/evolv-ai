import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { EngineeringActionService } from "../lib/engineering-actions.mjs";
import { createToolRegistry } from "../lib/tools.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolv-engineering-"));
  await writeFile(path.join(root, "app.js"), "export const value = 1;\n");
  const database = createDatabase({ dataDir: path.join(root, "profile"), defaultPrompt: "Test" });
  const fetchImpl = async () => new Response("<html><script>hostile()</script><body>Verified documentation text</body></html>", {
    headers: { "content-type": "text/html" }
  });
  const engineeringActions = new EngineeringActionService({
    database,
    workspaceRoot: root,
    fetchImpl,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  const registry = await createToolRegistry({
    workspaceRoot: root,
    database,
    engineeringActions,
    fetchImpl,
    searchKnowledge: async () => []
  });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  return { root, database, registry };
}

test("project edits are review-only, permission-scoped, stale-safe, and audited", async (t) => {
  const { root, database, registry } = await fixture(t);
  const denied = await registry.execute("propose_workspace_edit", {
    path: "app.js", find: "value = 1", replace: "value = 2", summary: "Update the test value"
  }, { packPermissions: ["filesystem.read.project"] });
  assert.equal(denied.ok, false);
  assert.match(denied.output, /PACK_PERMISSION_DENIED/);
  assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const value = 1;\n");

  const proposed = await registry.execute("propose_workspace_edit", {
    path: "app.js", find: "value = 1", replace: "value = 2", summary: "Update the test value"
  }, { packPermissions: ["filesystem.write.project"] });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.pendingApproval, true);
  assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const value = 1;\n");
  const approved = await registry.decideEngineeringAction(proposed.runId, "approved");
  assert.equal(approved.result.operation, "edited");
  assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const value = 2;\n");
  assert.equal(database.listToolRuns().find((run) => run.id === proposed.runId).status, "pending-approval");

  const stale = await registry.execute("propose_workspace_edit", {
    path: "app.js", find: "value = 2", replace: "value = 3", summary: "Try a stale change"
  }, { packPermissions: ["filesystem.write.project"] });
  await writeFile(path.join(root, "app.js"), "export const value = 9;\n");
  await assert.rejects(() => registry.decideEngineeringAction(stale.runId, "approved"), /changed after review/);
  assert.equal(await readFile(path.join(root, "app.js"), "utf8"), "export const value = 9;\n");
});

test("new files, engineering checks, and public research all require individual approval", async (t) => {
  const { root, database, registry } = await fixture(t);
  const moduleContent = `// ${"bounded".repeat(450)}\nexport default true;\n`;
  const created = await registry.execute("propose_workspace_create", {
    path: "new-module.mjs", content: moduleContent, summary: "Add the verified module"
  }, { packPermissions: ["filesystem.write.project"] });
  assert.equal(created.pendingApproval, true);
  const logged = database.listToolRuns().find((run) => run.id === created.runId);
  assert.match(logged.arguments.content, /^\[\d+ chars; sha256:/);
  assert.equal(JSON.stringify(logged.arguments).includes("boundedboundedbounded"), false);
  await registry.decideEngineeringAction(created.runId, "approved");
  assert.equal(await readFile(path.join(root, "new-module.mjs"), "utf8"), moduleContent);

  const check = await registry.execute("propose_engineering_check", {
    check: "npm-script", script: "test", summary: "Run regression tests"
  }, { packPermissions: ["terminal.execute.approved"] });
  assert.equal(check.pendingApproval, true);
  const rejected = await registry.decideEngineeringAction(check.runId, "rejected");
  assert.equal(rejected.approved, false);

  const research = await registry.execute("propose_web_research", {
    url: "https://example.com/docs", purpose: "Read the primary documentation"
  }, { packPermissions: ["network.internet"] });
  assert.equal(research.pendingApproval, true);
  const result = await registry.decideEngineeringAction(research.runId, "approved");
  assert.match(result.result.text, /Verified documentation text/);
  assert.doesNotMatch(result.result.text, /hostile\(\)/);

  const blocked = await registry.execute("propose_web_research", {
    url: "https://127.0.0.1/private", purpose: "Attempt local access"
  }, { packPermissions: ["network.internet"] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /NETWORK_DENIED/);
});

test("engineering command validation rejects arbitrary scripts and paths", async (t) => {
  const { registry } = await fixture(t);
  const deploy = await registry.execute("propose_engineering_check", {
    check: "npm-script", script: "deploy", summary: "Unsafe deployment"
  }, { packPermissions: ["terminal.execute.approved"] });
  assert.equal(deploy.ok, false);
  assert.match(deploy.output, /COMMAND_DENIED/);
  const traversal = await registry.execute("propose_workspace_create", {
    path: "../escape.js", content: "bad", summary: "Escape"
  }, { packPermissions: ["filesystem.write.project"] });
  assert.equal(traversal.ok, false);
  assert.match(traversal.output, /PATH_DENIED/);
});

test("cloud pack sessions cannot expose project files without the send-files permission", async (t) => {
  const { registry } = await fixture(t);
  const restricted = registry.schemas({ providerId: "openai", packPermissions: ["filesystem.read.project"] });
  assert.equal(restricted.some((tool) => tool.function.name === "read_workspace_text"), false);
  const denied = await registry.execute("read_workspace_text", { path: "app.js" }, {
    providerId: "openai", packPermissions: ["filesystem.read.project"]
  });
  assert.equal(denied.ok, false);
  assert.match(denied.output, /models\.send-files/);
  const allowed = registry.schemas({ providerId: "openai", packPermissions: ["filesystem.read.project", "models.send-files"] });
  assert.equal(allowed.some((tool) => tool.function.name === "read_workspace_text"), true);
});
