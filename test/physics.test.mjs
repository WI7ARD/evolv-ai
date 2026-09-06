import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { createToolRegistry } from "../lib/tools.mjs";
import { handlePhysicsRoutes } from "../server/physics-routes.mjs";
import { PhysicsService, MAX_BODIES, WORLD_HEIGHT, PHYSICS_KINDS, MATERIALS, SCENE_VERSION } from "../lib/physics.mjs";

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
  assert.deepEqual(exposed.sort(), ["physics_adjust", "physics_build", "physics_connect", "physics_look", "physics_run"]);

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

  assert.equal(physicsTools.length, 5);
  for (const tool of physicsTools) {
    // A scene is memory. Prompting to drop a box would train someone to
    // approve without reading, which is what makes the real prompts work.
    assert.ok(["read", "sandbox", "record"].includes(tool.risk), `${tool.name} must stay in the automatic tier, got ${tool.risk}`);
    assert.equal(tool.permission, null, `${tool.name} needs no capability grant`);
  }

  const bad = await registry.execute("physics_build", { kind: "pyramid", x: 10, y: 10 }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.output, /kind must be one of: box, circle/);
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

  // Every control must have a handler. The drop buttons are checked separately
  // against the engine's own list, since they are data rather than ids.
  // The id, not the selector spelling: the sliders are wired through a shared
  // helper, so "#physics-gravity" never appears literally even though it is
  // handled. Matching the id keeps the check honest without dictating style.
  for (const control of ["physics-play", "physics-clear", "physics-gravity", "physics-wind", "physics-material", "physics-delete-mode", "physics-tools"]) {
    assert.match(html, new RegExp(`id="${control}"`), `${control} is missing from the page`);
    assert.match(ui, new RegExp(control), `${control} has no handler`);
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

test("every advertised shape can actually be built", () => {
  const physics = new PhysicsService();
  const built = PHYSICS_KINDS.map((kind) => physics.apply(`create_${kind}`, { x: 400, y: 200 }));

  assert.equal(built.length, PHYSICS_KINDS.length);
  assert.deepEqual(built.map((object) => object.kind), PHYSICS_KINDS);
  assert.equal(physics.perceive().objectCount, PHYSICS_KINDS.length);
  // Prefabs are several bodies but one object; that is the whole point of the
  // group model, and the object count above is what proves it.
  assert.ok(physics.perceive().partCount > PHYSICS_KINDS.length);
});

test("a star is genuinely concave rather than quietly hulled", () => {
  // Matter can only decompose concave outlines with the optional poly-decomp
  // package, which is absent. Bodies.fromVertices does not fail without it —
  // it returns the convex hull, so a five-pointed star would silently become a
  // pentagon. Building it from parts is what keeps the points.
  const physics = new PhysicsService();
  physics.addStar({ x: 400, y: 300, points: 5, radius: 50 });
  const pieces = physics.frame().bodies;
  assert.equal(pieces.length, 5, "a star must draw as five spikes, not one blob");
  assert.ok(pieces.every((piece) => piece.vertices.length >= 3));
});

test("a gear stays on its axle and a car drives down a slope", () => {
  const gears = new PhysicsService();
  const gear = gears.addGear({ x: 400, y: 300, radius: 50, teeth: 8, speed: 0.25 });
  gears.step(60);
  const spun = gears.describe(gear.id);
  assert.ok(Math.abs(spun.angleDegrees) > 100, "a driven gear must turn");
  assert.ok(Math.abs(spun.x - 400) < 5 && Math.abs(spun.y - 300) < 5, "a gear must not wander off its pin");
  assert.equal(gears.frame().bodies.length, 9, "a gear draws as a hub plus its teeth");

  const road = new PhysicsService();
  road.addRamp({ x: 400, y: 420, width: 700, height: 20, angle: 0.18 });
  const car = road.addCar({ x: 180, y: 300 });
  assert.equal(car.parts, 3, "a car is a chassis and two wheels");
  road.step(240);
  assert.ok(road.describe(car.id).x > 260, "a car on a slope must roll downhill");
});

test("materials change how things behave, not just what they are called", () => {
  const drop = (material) => {
    const physics = new PhysicsService();
    const ball = physics.addCircle({ x: 400, y: 100, radius: 25, material });
    physics.step(60);
    let highest = WORLD_HEIGHT;
    for (let index = 0; index < 200; index += 1) {
      physics.step(1);
      highest = Math.min(highest, physics.describe(ball.id).y);
    }
    return { mass: physics.describe(ball.id).mass, bounce: WORLD_HEIGHT - highest };
  };
  const plain = drop("default");
  assert.ok(drop("rubber").bounce > plain.bounce * 2, "rubber must visibly out-bounce the default");
  assert.ok(drop("metal").mass > plain.mass * 4, "metal must be much heavier");
  assert.ok(drop("wood").mass < plain.mass, "wood must be lighter");

  const slide = (material) => {
    const physics = new PhysicsService();
    physics.addRamp({ x: 400, y: 400, width: 500, height: 20, angle: 0.25 });
    const box = physics.addBox({ x: 250, y: 300, width: 40, height: 40, material });
    physics.step(180);
    return physics.describe(box.id).x;
  };
  assert.ok(slide("ice") > slide("default") + 100, "ice must slide further than the default");
  assert.throws(() => new PhysicsService().addBox({ x: 1, y: 1, material: "cheese" }), /Unknown material/);
});

test("wind pushes everything that can move and nothing that cannot", () => {
  const physics = new PhysicsService();
  physics.setGravity(0);
  const light = physics.addCircle({ x: 400, y: 300, radius: 15, material: "wood" });
  const heavy = physics.addCircle({ x: 400, y: 200, radius: 15, material: "metal" });
  const fixed = physics.addRamp({ x: 400, y: 500, width: 200, height: 20, angle: 0 });

  physics.setWind(2);
  physics.step(120);
  const lightMoved = physics.describe(light.id).x - 400;
  const heavyMoved = physics.describe(heavy.id).x - 400;

  assert.ok(lightMoved > 50, "wind must move a light object");
  // Scaled by mass, so wind accelerates everything alike. Otherwise heavy
  // things ignore it and light things fly off, which reads as a bug.
  assert.ok(Math.abs(lightMoved - heavyMoved) < 5, "wind must not favour light objects");
  assert.equal(physics.describe(fixed.id).x, 400, "wind must never move a fixed object");
  assert.equal(physics.perceive().wind, 2);
  assert.throws(() => physics.setWind(99), /between/);
});

test("springs pull, pins hold, and a deleted end takes its joint with it", () => {
  const physics = new PhysicsService();
  physics.setGravity(0);
  const a = physics.addCircle({ x: 200, y: 300, radius: 20 });
  const b = physics.addCircle({ x: 600, y: 300, radius: 20 });

  const spring = physics.addSpring({ a: a.id, b: b.id, length: 100, stiffness: 0.02 });
  assert.deepEqual(spring.connects, [a.id, b.id]);
  physics.step(180);
  const gap = Math.abs(physics.describe(a.id).x - physics.describe(b.id).x);
  assert.ok(Math.abs(gap - 100) < 25, `a spring must settle near its rest length, got ${gap}`);

  // A joint is drawn, or the scene looks broken.
  assert.ok(physics.frame().links.some((link) => link.springy), "a spring must appear in the frame");

  physics.remove(a.id);
  assert.equal(physics.perceive().objects.some((object) => object.kind === "spring"), false,
    "a joint whose end is gone would pull on nothing");
  assert.throws(() => physics.addPin({ a: b.id, b: b.id }), /two different objects/);
});

test("a prefab moves and dies as one object", () => {
  const physics = new PhysicsService();
  const ragdoll = physics.addRagdoll({ x: 400, y: 200 });
  assert.ok(ragdoll.parts > 5, "a ragdoll is several bodies");
  assert.equal(physics.perceive().objectCount, 1, "but it is one object to a reader");

  // Any limb identifies the whole figure, which is what a click means.
  physics.step(30);
  const limb = physics.frame().bodies[3];
  assert.equal(physics.at(limb.x, limb.y)?.id, ragdoll.id);

  physics.push({ id: ragdoll.id, vx: 8, vy: 0 });
  physics.step(30);
  assert.ok(physics.describe(ragdoll.id).x > 400, "pushing a ragdoll must move the whole figure");

  physics.remove(ragdoll.id);
  assert.equal(physics.perceive().partCount, 0, "removing a prefab must leave no orphan limbs");
});

test("the toolbar, the tool schema, and the dispatch switch cannot drift apart", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const [html, ui] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/physics.js", import.meta.url), "utf8")
  ]);

  // Every kind the engine can build has a button, and every button names a
  // kind the engine can build.
  const buttons = [...html.matchAll(/data-kind="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...buttons].sort(), [...PHYSICS_KINDS].sort());
  for (const joint of ["spring", "pin"]) assert.match(html, new RegExp(`data-joint="${joint}"`));

  // The material dropdown must offer exactly what the engine accepts. Scoped
  // to that select — the page has other dropdowns whose options are unrelated.
  const select = html.match(/<select id="physics-material">([\s\S]*?)<\/select>/)?.[1] || "";
  const options = [...select.matchAll(/value="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options.sort(), Object.keys(MATERIALS).sort());
  assert.match(html, /id="physics-wind"/);
  assert.match(html, /id="physics-delete-mode"/);

  // Hover is resolved in the page on purpose: a request per mouse move would
  // lag the cursor. It is hit-testing, not simulation.
  // Pointer events rather than mouse events, so dragging works under a finger
  // as well as a cursor.
  assert.match(ui, /pointermove/);
  assert.match(ui, /pointInPolygon/);
  assert.doesNotMatch(ui, /Engine\.update|Bodies\.rectangle|import .*matter/i);

  // The model can reach every kind the toolbar can.
  const { registry } = await registryFixture(t);
  const build = registry.schemas({}).find((tool) => tool.function.name === "physics_build");
  assert.deepEqual([...build.function.parameters.properties.kind.enum].sort(), [...PHYSICS_KINDS].sort());
  const adjust = registry.schemas({}).find((tool) => tool.function.name === "physics_adjust");
  assert.ok(adjust.function.parameters.properties.action.enum.includes("set_wind"));
});

test("a model can build a prefab, join two objects, and blow them sideways", async (t) => {
  const { registry } = await registryFixture(t);

  const car = await call(registry, "physics_build", { kind: "car", x: 300, y: 150, material: "metal" });
  assert.equal(car.ok, true);
  assert.equal(car.payload.kind, "car");
  assert.equal(car.payload.material, "metal");

  const ball = await call(registry, "physics_build", { kind: "circle", x: 500, y: 150 });
  const joined = await call(registry, "physics_connect", { joint: "spring", a: car.payload.id, b: ball.payload.id });
  assert.equal(joined.ok, true);
  assert.deepEqual(joined.payload.connects, [car.payload.id, ball.payload.id]);

  const windy = await call(registry, "physics_adjust", { action: "set_wind", wind: -2 });
  assert.equal(windy.payload.wind, -2);
  const ran = await call(registry, "physics_run", { steps: 120 });
  assert.equal(ran.payload.scene.wind, -2);
  assert.match(ran.payload.scene.summary, /wind -2/);

  const bad = await registry.execute("physics_connect", { joint: "spring", a: "ghost-9", b: ball.payload.id }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.output, /No object named ghost-9/);
});

test("a paused drag places an object exactly and leaves it still", () => {
  const physics = new PhysicsService();
  const box = physics.addBox({ x: 200, y: 300, width: 40, height: 40 });

  physics.grab({ id: box.id, x: 200, y: 300 });
  physics.dragTo({ x: 600, y: 150, live: false });
  physics.release();

  const moved = physics.describe(box.id);
  assert.equal(moved.x, 600);
  assert.equal(moved.y, 150);
  // Velocity is cleared, or the object shoots away the moment the clock starts.
  assert.equal(moved.speed, 0);
});

test("a live drag pulls an object rather than teleporting it", () => {
  const physics = new PhysicsService();
  const ball = physics.addCircle({ x: 200, y: 300, radius: 25 });

  physics.grab({ id: ball.id, x: 200, y: 300 });
  physics.dragTo({ x: 650, y: 300, live: true });
  // The constraint needs solver ticks to act; that is the point of dragging
  // rather than placing — the object swings and collides on the way.
  assert.ok(physics.describe(ball.id).x < 260, "a live drag must not jump instantly");
  physics.step(120);
  assert.ok(Math.abs(physics.describe(ball.id).x - 650) < 40, "the object must reach the cursor");

  physics.release();
  physics.step(1);
  assert.equal(physics.perceive().objects.length, 1);
});

test("fixed objects can be repositioned even though no force can move them", () => {
  const physics = new PhysicsService();
  const ramp = physics.addRamp({ x: 300, y: 400, width: 200, height: 20 });
  assert.equal(physics.describe(ramp.id).fixed, true);

  physics.grab({ id: ramp.id, x: 300, y: 400 });
  physics.dragTo({ x: 500, y: 250, live: true });
  physics.release();

  // A constraint does nothing to a static body, so this path has to move it
  // directly or ramps would be permanently stuck where they landed.
  assert.equal(physics.describe(ramp.id).x, 500);
  assert.equal(physics.describe(ramp.id).y, 250);
});

test("dragging a prefab moves every part together", () => {
  const physics = new PhysicsService();
  const ragdoll = physics.addRagdoll({ x: 200, y: 200 });
  const before = physics.frame().bodies.map((body) => [body.x, body.y]);

  physics.grab({ id: ragdoll.id, x: 200, y: 200 });
  physics.dragTo({ x: 500, y: 200, live: false });
  physics.release();

  const after = physics.frame().bodies.map((body) => [body.x, body.y]);
  const deltas = before.map(([x, y], index) => `${(after[index][0] - x).toFixed(1)},${(after[index][1] - y).toFixed(1)}`);
  assert.equal(new Set(deltas).size, 1, "a dragged ragdoll must keep its shape");
  assert.equal(deltas[0], "300.0,0.0");
});

test("dragging cleans up after itself", () => {
  const physics = new PhysicsService();
  const box = physics.addBox({ x: 300, y: 300 });

  // Deleting what the cursor holds must not leave a constraint attached to a
  // body that no longer exists — the solver would fault on the next tick.
  physics.grab({ id: box.id, x: 300, y: 300 });
  physics.remove(box.id);
  physics.step(30);
  assert.equal(physics.perceive().objectCount, 0);

  const other = physics.addCircle({ x: 100, y: 100 });
  physics.grab({ id: other.id, x: 100, y: 100 });
  physics.clear();
  physics.step(30);
  assert.equal(physics.perceive().objectCount, 0);

  assert.throws(() => physics.dragTo({ x: 10, y: 10 }), /Nothing is being dragged/);
  assert.deepEqual(physics.release(), { released: null });
});

test("a model can place an object without a cursor", async (t) => {
  const { registry } = await registryFixture(t);
  const built = await call(registry, "physics_build", { kind: "box", x: 100, y: 100 });
  const moved = await call(registry, "physics_adjust", { action: "move", id: built.payload.id, x: 700, y: 250 });

  assert.equal(moved.ok, true);
  assert.equal(moved.payload.x, 700);
  assert.equal(moved.payload.y, 250);
});

test("the canvas drags with one request in flight at a time", async () => {
  const { readFile } = await import("node:fs/promises");
  const [ui, routes] = await Promise.all([
    readFile(new URL("../public/physics.js", import.meta.url), "utf8"),
    readFile(new URL("../server/physics-routes.mjs", import.meta.url), "utf8")
  ]);

  assert.match(ui, /pointerdown/);
  assert.match(ui, /pointerup/);
  // Without coalescing, a fast drag queues a request per pointer event and the
  // object trails the cursor by the whole backlog.
  assert.match(ui, /inFlight/);
  assert.match(ui, /pending/);
  // The other tools own the click; dragging must not steal it.
  assert.match(ui, /state\.deleting \|\| state\.pendingJoint/);
  assert.match(ui, /swallowClick/);
  // Drag has its own route so a mouse move does not build a prose summary.
  assert.match(routes, /\/api\/physics\/drag/);
  assert.doesNotMatch(routes.split("/api/physics/drag")[1].split("if (req.method")[0], /perceive/);
});

test("a saved scene rebuilds exactly, in a fresh engine", () => {
  const build = () => {
    const physics = new PhysicsService();
    physics.addRamp({ x: 400, y: 420, width: 380, height: 20, angle: 0.35, material: "wood" });
    const ball = physics.addCircle({ x: 260, y: 200, radius: 22, material: "rubber" });
    physics.addRagdoll({ x: 500, y: 120 });
    const car = physics.addCar({ x: 150, y: 520, material: "metal" });
    physics.addSpring({ a: ball.id, b: car.id, length: 120, stiffness: 0.03 });
    physics.setGravity(0.9);
    physics.setWind(0.4);
    physics.step(200);
    return physics;
  };

  const original = build();
  const snapshot = original.snapshot();
  const restored = new PhysicsService();
  restored.restore(snapshot);

  const before = original.perceive();
  const after = restored.perceive();

  // Contacts are solver output, not state: a restored world has not stepped
  // yet, so it has no pairs. Everything that is actually state must match.
  const { contacts: _ignoredBefore, ...beforeState } = before;
  const { contacts: _ignoredAfter, ...afterState } = after;
  assert.deepEqual(afterState, beforeState);

  // Ids survive, so the spring still joins the two objects it named.
  const spring = after.objects.find((object) => object.kind === "spring");
  assert.deepEqual(spring.connects, before.objects.find((object) => object.kind === "spring").connects);

  // A prefab keeps its pose, not just its centre: construction alone would
  // rebuild the ragdoll standing up rather than however it landed.
  assert.deepEqual(restored.frame().bodies.map((body) => [body.x, body.y]),
    original.frame().bodies.map((body) => [body.x, body.y]));
});

test("reset returns a run scene to how it was built", () => {
  const physics = new PhysicsService();
  const ball = physics.addCircle({ x: 400, y: 80, radius: 25 });
  physics.addRamp({ x: 400, y: 400, width: 300, height: 20, angle: 0.3 });
  const start = physics.describe(ball.id);

  physics.step(300);
  assert.ok(physics.describe(ball.id).y > start.y + 100, "the ball should have moved");

  physics.reset();
  assert.equal(physics.describe(ball.id).x, start.x);
  assert.equal(physics.describe(ball.id).y, start.y);
  assert.equal(physics.perceive().elapsedSeconds, 0);

  // Repeatable: reset is not a one-shot undo.
  physics.step(300);
  physics.reset();
  assert.equal(physics.describe(ball.id).y, start.y);

  assert.throws(() => new PhysicsService().reset(), /has not been run yet/);
});

test("adding something after a run moves the point reset returns to", () => {
  const physics = new PhysicsService();
  const first = physics.addCircle({ x: 200, y: 100, radius: 20 });
  physics.step(120);
  const settled = physics.describe(first.id).y;

  // The mark is taken at the first step after any structural change, so the
  // new object joins the scene reset returns to rather than vanishing from it.
  const second = physics.addBox({ x: 500, y: 100, width: 40, height: 40 });
  physics.step(120);
  physics.reset();

  assert.equal(physics.perceive().objectCount, 2, "reset must not delete what was added");
  assert.equal(physics.describe(first.id).y, settled);
  assert.equal(physics.describe(second.id).y, 100);
});

test("a scene from a newer build is refused rather than half-applied", () => {
  const physics = new PhysicsService();
  physics.addCircle({ x: 200, y: 100, radius: 20 });
  const snapshot = physics.snapshot();

  const target = new PhysicsService();
  target.addBox({ x: 50, y: 50 });
  assert.throws(
    () => target.restore({ ...snapshot, version: SCENE_VERSION + 1 }),
    (error) => error.code === "PHYSICS_SCENE_VERSION"
  );
  // Refused means untouched, not emptied.
  assert.equal(target.perceive().objectCount, 1);

  assert.throws(() => target.restore(null), /not a saved scene/);
  assert.throws(() => target.restore({ version: 1, objects: [{ id: "x-1", kind: "wormhole" }] }), /unknown object/);
});

test("a joint whose object is missing is dropped rather than fatal", () => {
  const physics = new PhysicsService();
  const a = physics.addCircle({ x: 200, y: 200, radius: 20 });
  const b = physics.addCircle({ x: 400, y: 200, radius: 20 });
  physics.addSpring({ a: a.id, b: b.id });
  const snapshot = physics.snapshot();

  // A hand-edited or partially recovered file should still load what it can.
  snapshot.objects = snapshot.objects.filter((object) => object.id !== b.id);
  const restored = new PhysicsService();
  restored.restore(snapshot);

  assert.equal(restored.perceive().objectCount, 1);
  assert.equal(restored.perceive().objects.some((object) => object.kind === "spring"), false);
});

test("scenes save, list, reload, and delete over HTTP", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-scenes-"));
  const database = createDatabase({ dataDir: path.join(root, "data"), defaultPrompt: "Test" });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const physicsService = new PhysicsService();
  const sent = [];
  const call = (method, pathname, body = {}) => handlePhysicsRoutes({
    req: { method }, res: {}, url: new URL(`http://x${pathname}`),
    readBody: async () => body, bodyLimit: 10_000,
    json: (_res, status, payload) => sent.push({ status, payload }),
    physicsService, database
  });

  const ball = physicsService.addCircle({ x: 200, y: 100, radius: 20 });
  physicsService.addRamp({ x: 400, y: 400 });
  physicsService.step(120);
  const settled = physicsService.describe(ball.id).y;

  await call("POST", "/api/physics/scenes", { name: "Ramp test" });
  assert.equal(sent.at(-1).status, 201);
  const saved = sent.at(-1).payload;
  assert.equal(saved.objectCount, 2);

  await call("GET", "/api/physics/scenes");
  assert.deepEqual(sent.at(-1).payload.scenes.map((scene) => scene.name), ["Ramp test"]);

  // Wreck the live scene, then bring the saved one back.
  physicsService.clear();
  assert.equal(physicsService.perceive().objectCount, 0);
  await call("POST", `/api/physics/scenes/${saved.id}/load`);
  assert.equal(sent.at(-1).payload.name, "Ramp test");
  assert.equal(physicsService.perceive().objectCount, 2);
  assert.equal(physicsService.describe(ball.id).y, settled, "a reloaded scene is where it was saved");

  await call("DELETE", `/api/physics/scenes/${saved.id}`);
  assert.equal(sent.at(-1).payload.removed, true);
  await call("GET", "/api/physics/scenes");
  assert.deepEqual(sent.at(-1).payload.scenes, []);

  await assert.rejects(() => call("POST", `/api/physics/scenes/${saved.id}/load`), (error) => error.code === "SCENE_NOT_FOUND");
  await assert.rejects(() => call("POST", "/api/physics/scenes", { name: "  " }), (error) => error.code === "SCENE_NAME_REQUIRED");
});

test("reset is reachable over HTTP and every scene control is wired to the page", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-reset-"));
  const database = createDatabase({ dataDir: path.join(root, "data"), defaultPrompt: "Test" });
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const physicsService = new PhysicsService();
  const sent = [];
  const call = (method, pathname) => handlePhysicsRoutes({
    req: { method }, res: {}, url: new URL(`http://x${pathname}`),
    readBody: async () => ({}), bodyLimit: 10_000,
    json: (_res, status, payload) => sent.push({ status, payload }),
    physicsService, database
  });

  const ball = physicsService.addCircle({ x: 400, y: 80, radius: 25 });
  physicsService.step(200);
  assert.ok(physicsService.describe(ball.id).y > 200);
  await call("POST", "/api/physics/reset");
  assert.equal(physicsService.describe(ball.id).y, 80);

  const { readFile } = await import("node:fs/promises");
  const [html, ui] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/physics.js", import.meta.url), "utf8")
  ]);
  for (const control of ["physics-reset", "physics-save", "physics-load", "physics-scene-delete", "physics-scene-name", "physics-scene-list"]) {
    assert.match(html, new RegExp(`id="${control}"`), `${control} is missing from the page`);
    assert.match(ui, new RegExp(control), `${control} has no handler`);
  }
});
