import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { SandboxService } from "../lib/sandbox.mjs";
import { perceive, spriteState, SKILLS, WORLD_VERSION } from "../lib/world.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-world-"));
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "app.mjs"), "export const value = 1;\n");
  const database = createDatabase({ dataDir: path.join(root, "profile"), defaultPrompt: "Test" });
  // Close before removing: Windows refuses to unlink SQLite's open WAL files,
  // and `after` hooks run in registration order.
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new SandboxService({
    database, projectService: { async rootFor() { return project; } },
    sandboxRoot: path.join(root, "sandboxes")
  });
  return { service };
}

test("the world is derived only from work that really happened", async (t) => {
  const { service } = await fixture(t);
  const opened = await service.open({ projectId: "p1", objective: "Raise the value" });

  // Nothing edited yet: no file objects may exist, however pretty that would be.
  let view = perceive(service.get(opened.id));
  assert.equal(view.worldVersion, WORLD_VERSION);
  assert.equal(view.objects.filter((item) => item.type === "file").length, 0);
  assert.equal(view.inventory.length, 0);
  assert.equal(view.projectUntouched, true);
  assert.equal(view.sprite.state, "planning", "an empty sandbox is not pretending to code");

  await service.applyEdit(opened.id, { path: "src/app.mjs", content: "export const value = 2;\n", summary: "Bump" });
  view = perceive(service.get(opened.id));
  const file = view.objects.find((item) => item.id === "file:src/app.mjs");
  assert.ok(file, "an edited file must appear");
  assert.equal(file.state, "staged");
  assert.equal(view.sprite.state, "coding");
  assert.deepEqual(view.inventory, [{ path: "src/app.mjs", operation: "edit", bytes: 24 }]);

  await service.validate(opened.id);
  view = perceive(service.get(opened.id));
  assert.equal(view.objects.find((item) => item.id === "file:src/app.mjs").state, "checked");
  assert.equal(view.sprite.state, "celebrating");
  assert.equal(view.projectUntouched, true, "a validated simulation still has not touched the project");
});

test("layout is deterministic so the map does not wander between frames", async (t) => {
  const { service } = await fixture(t);
  const opened = await service.open({ projectId: "p1" });
  await service.applyEdit(opened.id, { path: "src/app.mjs", content: "export const value = 3;\n" });
  const first = perceive(service.get(opened.id));
  const second = perceive(service.get(opened.id));
  assert.deepEqual(first.objects.map((item) => item.position), second.objects.map((item) => item.position));
  // Every object sits inside its declared zone.
  for (const object of first.objects) {
    const zone = first.zones.find((item) => item.id === object.zone);
    assert.ok(object.position.x >= zone.x && object.position.x <= zone.x + zone.width, `${object.id} escaped ${zone.id} horizontally`);
    assert.ok(object.position.y >= zone.y && object.position.y <= zone.y + zone.height, `${object.id} escaped ${zone.id} vertically`);
  }
});

test("the sprite never claims success while checks are failing", async (t) => {
  const { service } = await fixture(t);
  const opened = await service.open({ projectId: "p1" });
  await service.applyEdit(opened.id, { path: "src/app.mjs", content: "export const value = ;\n" });
  await service.validate(opened.id);
  const view = perceive(service.get(opened.id));
  assert.equal(view.sprite.state, "error");
  assert.match(view.sprite.label, /untouched/i);
  assert.equal(view.objects.find((item) => item.id === "file:src/app.mjs").state, "failing");
  // Debugging becomes available precisely because something really failed.
  assert.equal(view.skills.find((skill) => skill.id === "debugging").available, true);
  assert.equal(view.skills.find((skill) => skill.id === "promoting").available, false);
});

test("skills describe capability and never execute anything", () => {
  for (const skill of SKILLS) {
    assert.ok(skill.id && skill.label && skill.summary, `${skill.id} is incomplete`);
    assert.ok(Array.isArray(skill.tools));
    // A skill may only name tools; it carries no code of its own.
    assert.equal(typeof skill.run, "undefined");
    assert.equal(typeof skill.execute, "undefined");
  }
  assert.deepEqual(spriteState(null), { state: "idle", label: "Waiting for something to do" });
});

test("perception refuses to invent a session", () => {
  assert.throws(() => perceive(null), (error) => error.code === "WORLD_SESSION_REQUIRED");
  assert.throws(() => perceive({}), (error) => error.code === "WORLD_SESSION_REQUIRED");
});
