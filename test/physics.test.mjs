import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { createToolRegistry } from "../lib/tools.mjs";
import { PhysicsService, MAX_BODIES, WORLD_HEIGHT } from "../lib/physics.mjs";

async function registryFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-physics-"));
  const database = createDatabase({ dataDir: path.join(root, "data"), defaultPrompt: "Test" });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const physicsService = new PhysicsService();
  const registry = await createToolRegistry({
    workspaceRoot: root, database, physicsService,
    searchKnowledge: async () => [], searchMemory: async () => []
  });
  return { registry, physicsService };
}

async function call(registry, name, args) {
  const result = await registry.execute(name, args, {});
  return { ok: result.ok, payload: JSON.parse(result.output) };
}

test("things fall, land, and stop", () => {
  const physics = new PhysicsService();
  const ball = physics.addCircle({ x: 400, y: 50, radius: 30 });
  assert.equal(ball.y, 50);

  physics.step(400);
  const landed = physics.describe(ball.id);
  // The floor is at WORLD_HEIGHT, so a resting ball's centre sits one radius above it.
  assert.ok(Math.abs(landed.y - (WORLD_HEIGHT - 30)) < 2, `expected to rest near ${WORLD_HEIGHT - 30}, got ${landed.y}`);
  assert.equal(landed.resting, true);
  assert.equal(physics.perceive().settled, true);
});

test("a ball on a ramp rolls downhill", () => {
  const physics = new PhysicsService();
  physics.addRamp({ x: 400, y: 400, width: 400, height: 20, angle: 0.4 });
  const ball = physics.addCircle({ x: 300, y: 300, radius: 20 });

  physics.step(180);
  const rolled = physics.describe(ball.id);
  // The ramp tilts down to the right, so gravity must carry the ball that way.
  assert.ok(rolled.x > 340, `expected the ball to roll right, ended at x=${rolled.x}`);
  assert.ok(rolled.y > 300, `expected the ball to descend, ended at y=${rolled.y}`);
});

test("gravity is a dial, and zero means nothing falls", () => {
  const physics = new PhysicsService();
  physics.setGravity(0);
  const floater = physics.addCircle({ x: 400, y: 200, radius: 20 });
  physics.step(240);
  assert.equal(physics.describe(floater.id).y, 200, "with no gravity nothing should move");

  physics.setGravity(-1);
  physics.step(60);
  assert.ok(physics.describe(floater.id).y < 200, "negative gravity must lift it");
  assert.throws(() => physics.setGravity(50), /between/);
});

test("a motor spins in place instead of falling", () => {
  const physics = new PhysicsService();
  const motor = physics.addMotor({ x: 400, y: 300, radius: 40, speed: 0.3 });
  physics.step(60);

  const spun = physics.describe(motor.id);
  assert.ok(Math.abs(spun.angleDegrees) > 100, "a driven wheel must actually turn");
  // The constraint pins it: a motor that drifts is a wheel that fell off.
  assert.ok(Math.abs(spun.x - 400) < 5 && Math.abs(spun.y - 300) < 5, `motor drifted to ${spun.x},${spun.y}`);
});

test("the same scene run twice gives the same answer", () => {
  const build = () => {
    const physics = new PhysicsService();
    physics.addRamp({ x: 400, y: 420, width: 380, height: 20, angle: 0.35 });
    physics.addCircle({ x: 260, y: 260, radius: 22 });
    physics.addBox({ x: 500, y: 100, width: 40, height: 40 });
    physics.step(300);
    return physics.perceive();
  };
  // Without this the sandbox could not be reasoned about: a model that runs an
  // experiment twice and gets two answers has learned nothing.
  assert.deepEqual(build(), build());
});

test("perception reports contacts and never leaks the walls as objects", () => {
  const physics = new PhysicsService();
  physics.addCircle({ x: 400, y: 500, radius: 30 });
  physics.step(120);

  const view = physics.perceive();
  assert.equal(view.objectCount, 1, "the boundary walls must not be listed as objects");
  assert.equal(view.objects[0].id, "circle-1");
  assert.ok(view.contacts.some((contact) => contact.a === "wall" || contact.b === "wall"),
    "a ball resting on the floor is touching something and perception must say so");
  assert.match(view.summary, /1 object/);
});

test("nonsense never reaches the solver", () => {
  const physics = new PhysicsService();
  // A NaN position does not throw inside the engine; it quietly poisons the
  // body and then every body it touches, and the scene dies much later.
  assert.throws(() => physics.addBox({ x: NaN, y: 100 }), /finite/);
  assert.throws(() => physics.addBox({ x: 100, y: Infinity }), /finite/);
  assert.throws(() => physics.addCircle({ x: 100, y: 100, radius: -5 }), /between/);
  assert.throws(() => physics.push({ id: "nothing-here", vx: 1 }), /No object/);
  assert.throws(() => physics.apply("delete_everything", {}), /Unknown physics action/);

  const wall = physics.addRamp({ x: 400, y: 400, width: 200, height: 20 });
  assert.throws(() => physics.push({ id: wall.id, vx: 5 }), /fixed in place/);
});

test("the scene cannot grow without limit", () => {
  const physics = new PhysicsService();
  for (let index = 0; index < MAX_BODIES; index += 1) physics.addCircle({ x: 400, y: 100, radius: 5 });
  assert.equal(physics.perceive().objectCount, MAX_BODIES);
  assert.throws(() => physics.addCircle({ x: 400, y: 100, radius: 5 }), /already holds/);

  assert.equal(physics.clear().removed, MAX_BODIES);
  assert.equal(physics.perceive().objectCount, 0);
  // Ids restart, so a cleared scene behaves like a fresh one.
  assert.equal(physics.addCircle({ x: 400, y: 100 }).id, "circle-1");
});

test("removing an object takes its motor with it", () => {
  const physics = new PhysicsService();
  const motor = physics.addMotor({ x: 400, y: 300, speed: 0.4 });
  physics.remove(motor.id);
  physics.step(30);
  assert.equal(physics.perceive().objectCount, 0, "a removed motor must stop being driven");
});

test("the renderer gets solved vertices and needs no physics of its own", () => {
  const physics = new PhysicsService();
  physics.addBox({ x: 200, y: 100, width: 40, height: 40, angle: 0.5 });
  const frame = physics.frame();

  assert.equal(frame.bodies.length, 1);
  const [body] = frame.bodies;
  assert.equal(body.vertices.length, 4);
  // Rotation is already applied, which is the whole point: the page draws a
  // polygon and does no geometry.
  assert.ok(body.vertices.some(([x, y]) => x !== 200 && y !== 100));
  assert.deepEqual(frame.world, { width: 800, height: 600 });
});

test("clicking finds the object under the point", () => {
  const physics = new PhysicsService();
  const box = physics.addBox({ x: 300, y: 200, width: 60, height: 60, fixed: true, isStatic: true });
  assert.equal(physics.at(300, 200)?.id, box.id);
  assert.equal(physics.at(700, 50), null);
});

test("a model can build, run, and see the sandbox through tools", async (t) => {
  const { registry } = await registryFixture(t);

  const exposed = registry.schemas({}).map((tool) => tool.function.name).filter((name) => name.startsWith("physics_"));
  assert.deepEqual(exposed.sort(), ["physics_adjust", "physics_build", "physics_look", "physics_run"]);

  const built = await call(registry, "physics_build", { kind: "circle", x: 400, y: 50, radius: 30, note: "test ball" });
  assert.equal(built.ok, true);
  assert.equal(built.payload.id, "circle-1");
  assert.equal(built.payload.note, "test ball");

  // Nothing moves until time is asked for.
  const before = await call(registry, "physics_look", {});
  assert.equal(before.payload.objects[0].y, 50);

  const ran = await call(registry, "physics_run", { steps: 400 });
  assert.equal(ran.ok, true);
  assert.equal(ran.payload.scene.settled, true, "physics_run must report the outcome, not just the step count");
  assert.ok(ran.payload.scene.objects[0].y > 500);

  const cleared = await call(registry, "physics_adjust", { action: "clear" });
  assert.equal(cleared.payload.removed, 1);
  assert.equal((await call(registry, "physics_look", {})).payload.objectCount, 0);
});

test("the physics tools never ask for approval and never touch anything real", async (t) => {
  const { registry } = await registryFixture(t);
  const physicsTools = registry.list().filter((tool) => tool.name.startsWith("physics_"));

  assert.equal(physicsTools.length, 4);
  for (const tool of physicsTools) {
    // A scene is memory. Prompting to drop a box would train someone to
    // approve without reading, which is what makes the real prompts work.
    assert.ok(["read", "sandbox"].includes(tool.risk), `${tool.name} must stay in the automatic tier, got ${tool.risk}`);
    assert.equal(tool.permission, null, `${tool.name} needs no capability grant`);
  }

  const bad = await registry.execute("physics_build", { kind: "pyramid", x: 10, y: 10 }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.output, /box, circle, ramp, or motor/);
});

test("the physics sandbox is reachable and the page carries no engine of its own", async () => {
  const { readFile } = await import("node:fs/promises");
  const [html, app, ui, routes] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/physics.js", import.meta.url), "utf8"),
    readFile(new URL("../server/physics-routes.mjs", import.meta.url), "utf8")
  ]);

  // Reached by command, like /agent and /sandbox.
  assert.match(app, /name: "\/physics"/);
  assert.match(html, /id="physics-view"/);
  assert.match(html, /id="physics-canvas"/);
  assert.match(app, /initPhysics\(\{ api, toast \}\)/);
  assert.match(html, /id="physics-back-to-chat"/);

  // Every control in the toolbar must have a handler.
  for (const control of ["physics-play", "physics-add-box", "physics-add-circle", "physics-add-motor", "physics-add-ramp", "physics-clear", "physics-gravity"]) {
    assert.match(html, new RegExp(`id="${control}"`), `${control} is missing from the page`);
    assert.match(ui, new RegExp(`#${control}`), `${control} has no handler`);
  }

  // The CSP is script-src 'self', so a CDN would silently fail to load and the
  // view would be a blank rectangle. The page must stay free of one.
  assert.doesNotMatch(html, /cdnjs|unpkg|jsdelivr|matter\.min\.js/i);
  assert.doesNotMatch(ui, /import .*matter|require\(.*matter/i);
  // Drawing only: no solver in the renderer.
  assert.doesNotMatch(ui, /Engine\.update|Bodies\.rectangle/);
  assert.match(ui, /getContext\("2d"\)/);

  // Leaving the view has to stop the clock, or a background tab simulates forever.
  assert.match(app, /suspendPhysics\(\)/);
  assert.match(ui, /export function suspendPhysics/);

  // Reads are split by purpose: geometry for the canvas, meaning for a reader.
  assert.match(routes, /\/api\/physics\/frame/);
  assert.match(routes, /physicsService\.perceive\(\)/);
});
