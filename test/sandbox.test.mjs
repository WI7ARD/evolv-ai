import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { SandboxService, isDeniedPath } from "../lib/sandbox.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-sandbox-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "app.mjs"), "export const value = 1;\n");
  await writeFile(path.join(project, "notes.md"), "# Notes\n");
  // Things a sandbox must never mirror.
  await writeFile(path.join(project, ".env"), "SECRET_TOKEN=super-secret-value\n");
  await mkdir(path.join(project, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(project, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

  const database = createDatabase({ dataDir: path.join(root, "profile"), defaultPrompt: "Test" });
  t.after(() => database.close());
  const projectService = { async rootFor() { return project; } };
  const service = new SandboxService({
    database, projectService, sandboxRoot: path.join(root, "sandboxes")
  });
  return { root, project, database, service };
}

test("a sandbox mirrors project text and excludes secrets and dependencies", async (t) => {
  const { project, service } = await fixture(t);
  const session = await service.open({ projectId: "p1", objective: "Try a change" });

  assert.equal(session.state, "open");
  assert.ok(fs.existsSync(path.join(session.rootPath, "src", "app.mjs")), "project source must be mirrored");
  assert.ok(fs.existsSync(path.join(session.rootPath, "notes.md")));
  // The whole point of the denial list: a simulation cannot carry credentials.
  assert.equal(fs.existsSync(path.join(session.rootPath, ".env")), false, ".env must never enter a sandbox");
  assert.equal(fs.existsSync(path.join(session.rootPath, "node_modules")), false, "dependencies must not be copied");
  assert.equal(fs.readFileSync(path.join(project, ".env"), "utf8").includes("super-secret-value"), true);

  assert.ok(isDeniedPath(".env"));
  assert.ok(isDeniedPath("node_modules/left-pad/index.js"));
  assert.ok(isDeniedPath("config/credentials.json"));
  assert.equal(isDeniedPath("src/app.mjs"), false);
});

test("edits stay inside the sandbox until a promotion is approved", async (t) => {
  const { project, service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, {
    path: "src/app.mjs", content: "export const value = 2;\n", summary: "Bump the value"
  });

  // The real file is untouched — this is the safety claim.
  assert.equal(await readFile(path.join(project, "src", "app.mjs"), "utf8"), "export const value = 1;\n");
  const staged = service.get(session.id);
  assert.equal(staged.edits.length, 1);
  assert.equal(staged.edits[0].operation, "edit");
  assert.equal(await readFile(path.join(staged.rootPath, "src", "app.mjs"), "utf8"), "export const value = 2;\n");

  const validated = await service.validate(session.id);
  assert.equal(validated.state, "validated");
  assert.ok(validated.validations.some((item) => item.kind === "syntax:src/app.mjs" && item.passed));

  const promoted = await service.promote(session.id);
  assert.equal(promoted.state, "promoted");
  assert.deepEqual(promoted.applied, ["src/app.mjs"]);
  assert.equal(await readFile(path.join(project, "src", "app.mjs"), "utf8"), "export const value = 2;\n");
});

test("a failed simulation is discarded and costs the project nothing", async (t) => {
  const { project, service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, { path: "src/app.mjs", content: "export const value = ;\n" });

  const validated = await service.validate(session.id);
  assert.equal(validated.state, "failed", "broken syntax must fail validation");
  assert.ok(validated.validations.some((item) => !item.passed));

  // Promotion is refused while validation is red.
  await assert.rejects(() => service.promote(session.id), (error) => error.code === "SANDBOX_NOT_VALIDATED");
  assert.equal(await readFile(path.join(project, "src", "app.mjs"), "utf8"), "export const value = 1;\n");

  const discarded = await service.discard(session.id, "syntax error");
  assert.equal(discarded.state, "discarded");
  assert.equal(fs.existsSync(session.rootPath), false, "the sandbox directory must be removed");
  assert.equal(await readFile(path.join(project, "src", "app.mjs"), "utf8"), "export const value = 1;\n");
});

test("promotion refuses when the real file moved underneath the simulation", async (t) => {
  const { project, service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, { path: "src/app.mjs", content: "export const value = 2;\n" });
  await service.validate(session.id);

  // Someone else edits the file while the simulation was running.
  await writeFile(path.join(project, "src", "app.mjs"), "export const value = 99; // edited by hand\n");

  await assert.rejects(() => service.promote(session.id), (error) => error.code === "SANDBOX_STALE");
  assert.equal(
    await readFile(path.join(project, "src", "app.mjs"), "utf8"),
    "export const value = 99; // edited by hand\n",
    "the concurrent edit must survive untouched"
  );
});

test("a multi-file promotion is all-or-nothing", async (t) => {
  const { project, service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, { path: "src/app.mjs", content: "export const value = 3;\n" });
  await service.applyEdit(session.id, { path: "notes.md", content: "# Notes\n\nUpdated.\n" });
  await service.validate(session.id);

  // Make only the second target stale. Nothing at all should be written.
  await writeFile(path.join(project, "notes.md"), "# Notes\n\nChanged by hand.\n");
  await assert.rejects(() => service.promote(session.id), (error) => error.code === "SANDBOX_STALE");
  assert.equal(await readFile(path.join(project, "src", "app.mjs"), "utf8"), "export const value = 1;\n",
    "no file may be written when any file in the set is stale");
});

test("the sandbox refuses to simulate protected or escaping paths", async (t) => {
  const { service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  for (const relativePath of ["../outside.md", "/etc/passwd", ".env", "node_modules/x/index.js", "src/app.bin"]) {
    await assert.rejects(
      () => service.applyEdit(session.id, { path: relativePath, content: "x" }),
      (error) => error.code === "PATH_DENIED",
      `expected ${relativePath} to be refused`
    );
  }
});

test("validation may only run allowlisted checks", async (t) => {
  const { service } = await fixture(t);
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, { path: "notes.md", content: "# Notes\n\nEdited.\n" });
  for (const script of ["install", "publish", "start", "postinstall"]) {
    await assert.rejects(
      () => service.validate(session.id, { scripts: [script] }),
      (error) => error.code === "COMMAND_DENIED",
      `expected ${script} to be refused`
    );
  }
});

test("promotion requires an approval decision when approvals are wired", async (t) => {
  const { project, service, database } = await fixture(t);
  const approvals = [];
  service.approvalService = {
    create(request) { approvals.push(request); return { id: "approval-1", ...request }; }
  };
  const session = await service.open({ projectId: "p1" });
  await service.applyEdit(session.id, { path: "notes.md", content: "# Notes\n\nEdited.\n" });
  await service.validate(session.id);

  const requested = service.requestPromotion(session.id);
  assert.equal(requested.approvalRequired, true);
  assert.equal(approvals[0].kind, "sandbox-promotion");
  assert.equal(approvals[0].risk, "approval-write");
  assert.equal(approvals[0].after.files[0].path, "notes.md");
  assert.equal(approvals[0].after.validated, true);
  // Requesting is not doing: the file is still untouched.
  assert.equal(await readFile(path.join(project, "notes.md"), "utf8"), "# Notes\n");
  assert.ok(database.raw.prepare("SELECT 1 FROM audit_events WHERE event_type='sandbox.opened'").get());
});

test("the object view describes only what really happened", async (t) => {
  const { service } = await fixture(t);
  const session = await service.open({ projectId: "p1", objective: "Rename a value" });
  let view = service.objects(session.id);
  assert.equal(view.untouched, true);
  assert.deepEqual(view.available, ["apply-edit", "validate", "discard"]);
  assert.equal(view.objects.filter((item) => item.type === "file").length, 0,
    "no file objects before anything was actually edited");

  await service.applyEdit(session.id, { path: "src/app.mjs", content: "export const value = 4;\n" });
  await service.validate(session.id);
  view = service.objects(session.id);
  const file = view.objects.find((item) => item.id === "file:src/app.mjs");
  assert.ok(file, "an edited file must appear as an object");
  assert.equal(file.operation, "edit");
  assert.ok(file.validations.some((item) => item.passed));
  assert.deepEqual(view.available, ["promote", "discard"]);
});
