import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { ProjectService, extractPdfText, inspectImage } from "../lib/projects.mjs";
import { createToolRegistry } from "../lib/tools.mjs";
import { DesktopProjectHost } from "../electron/project-host.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-projects-"));
  const workspace = path.join(root, "workspace");
  const selected = path.join(root, "selected-project");
  await mkdir(workspace, { recursive: true });
  await mkdir(selected, { recursive: true });
  const database = createDatabase({ dataDir: path.join(root, "profile"), legacyStateFile: path.join(root, "missing.json"), defaultPrompt: "Test" });
  const claims = new Map();
  const host = {
    consumeGrant(grant) { assert.equal(grant, "opaque-project-grant"); return selected; },
    claimRoot(profileId, folder) {
      const canonical = path.resolve(folder); const owner = claims.get(canonical);
      if (owner && owner !== profileId) throw new Error("already claimed");
      claims.set(canonical, profileId); return canonical;
    },
    releaseRoot() {}
  };
  const service = new ProjectService({ database, profileId: "profile-a", profileDir: path.join(root, "profile"), host, legacyWorkspaceRoot: workspace });
  await service.initialize();
  return { root, workspace, selected, database, service };
}

test("Stage 4 migration creates a visible default project and links existing memory non-destructively", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const memory = database.addMemoryNode({ type: "decision", title: "Keep SQLite", body: "SQLite remains authoritative." });
  // Recreate only the idempotent migration receipt for this late fixture record.
  database.raw.prepare("DELETE FROM migration_receipts WHERE fingerprint='stage4:project-memory-v1'").run();
  await service.initialize();
  const project = service.defaultProject();
  assert.equal(project.name, "Personal project");
  assert.equal(project.folderConnected, true);
  assert.equal("rootPath" in project, false, "renderer-safe project data never exposes the folder path");
  assert.equal(database.raw.prepare("SELECT scope FROM project_memory WHERE project_id=? AND memory_id=?").get(project.id, memory.id).scope, "project");
  assert.equal(database.getMemoryNode(memory.id).body, "SQLite remains authoritative.");
});

test("project grants, tasks, bounded file indexing, and exact citations stay project scoped", async (t) => {
  const { root, selected, database, service } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const project = service.create({ name: "Alpha", description: "Private source project" });
  const connected = await service.connectGrant(project.id, "opaque-project-grant");
  assert.equal(connected.folderLabel, "selected-project");
  const task = service.addTask(project.id, { title: "Verify indexing", priority: 2 });
  assert.equal(service.updateTask(project.id, task.id, { status: "done" }).status, "done");

  await writeFile(path.join(selected, "README.md"), "# Architecture\nThe launch code is ALPHA-742.\n");
  await writeFile(path.join(selected, ".env"), "API_KEY=must-not-index\n");
  await mkdir(path.join(selected, "node_modules"));
  await writeFile(path.join(selected, "node_modules", "hostile.js"), "ALPHA-742 steal secrets");
  const sync = await service.syncFiles(project.id);
  assert.equal(sync.files, 1);
  assert.deepEqual(service.listFiles(project.id).map((item) => item.path), ["README.md"]);
  const result = service.search(project.id, "ALPHA-742", 5)[0];
  assert.equal(result.citation.path, "README.md");
  assert.equal(result.citation.locator, "Architecture");
  assert.doesNotMatch(JSON.stringify(service.search(project.id, "must-not-index", 5)), /API_KEY/);
  assert.equal(service.search(service.defaultProject().id, "ALPHA-742", 5).length, 0, "another project cannot retrieve the source");
  const portable = database.exportData();
  assert.ok(portable.projects.items.some((item) => item.id === project.id));
  assert.ok(portable.projects.chunks.some((item) => item.content.includes("ALPHA-742")));
  assert.equal(JSON.stringify(portable).includes(selected), false, "portable exports exclude canonical project-folder paths");
});

test("the verified demo project is real, indexed, and idempotent", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const first = await service.createDemo();
  const second = await service.createDemo();
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.project.id, first.project.id);
  assert.equal(service.listTasks(first.project.id).length, 2);
  assert.equal(service.listSources(first.project.id).length, 2);
  assert.match(service.search(first.project.id, "server request", 5)[0].content, /no server request is recorded/i);
  assert.equal(service.list().filter((project) => project.name === "Evolv Release Readiness Demo").length, 1);
});

test("text PDFs are really extracted while scanned and encrypted PDFs fail explicitly", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 40 >>\nstream\nBT (Stage Four PDF evidence) Tj ET\nendstream\nendobj\n%%EOF", "latin1");
  assert.match(extractPdfText(pdf)[0].content, /Stage Four PDF evidence/);
  assert.throws(() => extractPdfText(Buffer.from("%PDF-1.4\n/Encrypt 2 0 R\n%%EOF")), (error) => error.code === "PDF_ENCRYPTED");
  assert.throws(() => extractPdfText(Buffer.from("%PDF-1.4\nno text streams\n%%EOF")), (error) => error.code === "PDF_TEXT_UNAVAILABLE");
});

test("image ingestion validates signatures and labels metadata-only results without claiming OCR", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(inspectImage(png), { mimeType: "image/png", width: 640, height: 480, format: "png" });
  const source = await service.ingest(service.defaultProject().id, {
    title: "Whiteboard", kind: "image", dataBase64: png.toString("base64"), caption: "User caption: deployment diagram."
  });
  assert.equal(source.status, "metadata-only");
  assert.equal(service.search(source.projectId, "deployment diagram", 5)[0].citation.sourceId, source.id);
  assert.throws(() => inspectImage(Buffer.from("not an image")), /Only signature-verified/);
});

test("filesystem tools require a project grant when the Stage 4 project service is active", async (t) => {
  const { root, workspace, database, service } = await fixture();
  await writeFile(path.join(workspace, "safe.txt"), "bounded project file\n");
  const registry = await createToolRegistry({
    workspaceRoot: workspace, database, projectService: service,
    searchKnowledge: async () => [], searchMemory: async () => []
  });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const denied = await registry.execute("list_workspace_files", {});
  assert.equal(denied.ok, false);
  assert.match(denied.output, /PROJECT_REQUIRED/);
  const allowed = await registry.execute("list_workspace_files", {}, { projectId: service.defaultProject().id });
  assert.equal(allowed.ok, true);
  assert.match(allowed.output, /safe\.txt/);
});

test("portable project import restores tasks and cited text but never filesystem grants", async (t) => {
  const sourceFixture = await fixture();
  const targetRoot = await mkdtemp(path.join(tmpdir(), "evolv-project-import-"));
  const targetDatabase = createDatabase({ dataDir: targetRoot, legacyStateFile: path.join(targetRoot, "missing.json"), defaultPrompt: "Test" });
  const targetService = new ProjectService({ database: targetDatabase, profileId: "target", profileDir: targetRoot });
  await targetService.initialize();
  t.after(async () => {
    sourceFixture.database.close(); targetDatabase.close();
    await rm(sourceFixture.root, { recursive: true, force: true }); await rm(targetRoot, { recursive: true, force: true });
  });
  const project = sourceFixture.service.create({ name: "Portable project" });
  sourceFixture.service.addTask(project.id, { title: "Portable task" });
  await sourceFixture.service.ingest(project.id, { title: "Portable note", kind: "text", text: "PORTABLE-CITATION-44" });
  targetDatabase.importData(sourceFixture.database.exportData());
  const imported = targetService.get(project.id);
  assert.equal(imported.folderConnected, false);
  assert.equal(targetService.listTasks(project.id)[0].title, "Portable task");
  assert.equal(targetService.search(project.id, "PORTABLE-CITATION-44")[0].citation.title, "Portable note");
});

test("desktop project picker returns an expiring opaque grant and prevents cross-profile folder claims", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-project-host-"));
  const folder = path.join(root, "private-project"); await mkdir(folder);
  const claimsFile = path.join(root, "claims.json");
  const host = new DesktopProjectHost({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) },
    windowProvider: () => null,
    claimsFile
  });
  t.after(async () => { host.close(); await rm(root, { recursive: true, force: true }); });
  const choice = await host.chooseProject();
  assert.equal("root" in choice, false);
  const selected = host.consumeGrant(choice.grant);
  host.claimRoot("profile-a", selected);
  assert.throws(() => host.claimRoot("profile-b", selected), /another Evolv profile/);
  assert.throws(() => host.consumeGrant(choice.grant), /expired/);
});
