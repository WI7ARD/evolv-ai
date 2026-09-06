import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { CircuitService } from "../lib/circuit.mjs";
import { PhysicsService } from "../lib/physics.mjs";
import { BenchService } from "../lib/bench.mjs";
import {
  Coupling, exchange, rimSpeedKmh, tiltToGravity, rpmToRadiansPerStep,
  COUPLING_SECONDS, MAX_WORLD_RPM, PIXELS_PER_METRE
} from "../lib/coupling.mjs";

// The join between the two simulations. Most of what matters here is units and
// honesty: the two worlds measure different things at rates four orders of
// magnitude apart, and every crossing is a chance to be confidently wrong.

async function bench(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-couple-"));
  const database = createDatabase({ dataDir: root, dbPath: path.join(root, "c.db"), defaultPrompt: "test" });
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const circuitService = new CircuitService();
  const physicsService = new PhysicsService();
  return { database, circuitService, physicsService, bench: new BenchService({ database, circuitService, physicsService }) };
}

function drivenWheel({ circuitService, physicsService }, volts = 6) {
  circuitService.apply("add", { kind: "supply", volts, pins: { positive: "VCC", negative: "GND" } });
  circuitService.apply("add", { kind: "ground", pins: { pin: "GND" } });
  circuitService.apply("add", { kind: "motor", pins: { positive: "VCC", negative: "GND" } });
  return physicsService.addMotor({ x: 300, y: 300, radius: 40, speed: 0 });
}

test("a tilt becomes what an accelerometer lying on it would read", () => {
  // Not an analogy — this is the accelerometer equation. A board tilted 30°
  // really does read half a g on one axis, which is why an accelerometer works
  // as a tilt sensor at all.
  assert.deepEqual(tiltToGravity(0), { accelX: 0, accelZ: 1 });
  assert.deepEqual(tiltToGravity(30), { accelX: 0.5, accelZ: 0.866 });
  assert.deepEqual(tiltToGravity(90), { accelX: 1, accelZ: 0 });
});

test("a turning wheel becomes a road speed, from its own rim", () => {
  // v = ωr. A wheel with no radius reported — anything that is not a circle —
  // has no rim, so it contributes nothing rather than a number derived from a
  // radius somebody made up.
  const wheelMetres = 40 / PIXELS_PER_METRE;
  const expected = ((120 * 2 * Math.PI) / 60) * wheelMetres * 3.6;
  assert.ok(Math.abs(rimSpeedKmh(120, 40) - expected) < 1e-6);
  assert.equal(rimSpeedKmh(120, undefined), 0);
  assert.equal(rimSpeedKmh(120, 0), 0);
  // Direction does not change how fast you are going.
  assert.equal(rimSpeedKmh(-120, 40), rimSpeedKmh(120, 40));
});

test("a motor faster than the world can turn spins as fast as it can, and says so", () => {
  // The world carries angular velocity per step, so it has a ceiling. A
  // 3,500rpm motor quietly becoming a 573rpm one is the kind of silent
  // disagreement that makes a coupled run untrustworthy.
  const links = [{ kind: "spin", part: "M1", body: "motor-1", direction: "drive" }];
  const fast = exchange(links, { parts: { M1: { rpm: 3575 } }, bodies: { "motor-1": { rpm: 0, radius: 40 } } });
  assert.equal(fast.drives[0].saturated, true);
  assert.equal(fast.drives[0].radiansPerStep, 1);
  assert.match(fast.problems[0].message, /tops out near 573rpm/);
  // Keyed on the fault, not on the sentence: the sentence carries an rpm that
  // changes every interval, so one saturating link used to print four hundred
  // near-identical lines.
  assert.equal(fast.problems[0].key, "saturated:M1:motor-1");

  const gentle = exchange(links, { parts: { M1: { rpm: 120 } }, bodies: { "motor-1": { rpm: 0, radius: 40 } } });
  assert.equal(gentle.drives[0].saturated, false);
  assert.ok(Math.abs(gentle.drives[0].radiansPerStep - rpmToRadiansPerStep(120)) < 1e-12);
  assert.deepEqual(gentle.problems, []);
});

test("a link to something that is gone says so instead of failing the run", () => {
  const links = [
    { kind: "spin", part: "M1", body: "gone", direction: "drive" },
    { kind: "spin", part: "gone", body: "motor-1", direction: "drive" }
  ];
  const crossing = exchange(links, { parts: {}, bodies: { "motor-1": { rpm: 0 } } });
  assert.deepEqual(crossing.drives, []);
  assert.equal(crossing.problems.length, 2);
  assert.match(crossing.problems[0].message, /not in the world any more/);
  assert.match(crossing.problems[1].message, /not in the circuit any more/);
});

test("one link per crossing, so two drives cannot fight over one wheel", () => {
  const coupling = new Coupling();
  coupling.add({ kind: "spin", part: "M1", body: "motor-1" });
  assert.throws(() => coupling.add({ kind: "spin", part: "M2", body: "motor-1" }),
    (error) => error.code === "LINK_DUPLICATE");
  // A different crossing on the same body is fine: driving it and reading it
  // is the whole point.
  assert.equal(coupling.add({ kind: "speed", body: "motor-1" }).kind, "speed");
  assert.throws(() => coupling.add({ kind: "spin", body: "motor-2" }),
    (error) => error.code === "LINK_NO_PART");
  assert.throws(() => coupling.add({ kind: "levitate", body: "motor-2" }),
    (error) => error.code === "LINK_UNKNOWN_KIND");
});

test("the board drives the world and the world comes back", async (t) => {
  const parts = await bench(t);
  const wheel = drivenWheel(parts);
  parts.bench.link({ kind: "spin", part: "M1", body: wheel.id });
  parts.bench.link({ kind: "speed", body: wheel.id });

  const before = parts.physicsService.describe(wheel.id).rpm;
  assert.equal(before, 0, "the wheel is not turning until the board turns it");
  assert.equal(parts.circuitService.perceive().conditions.now.speed, 0);

  const run = parts.bench.runCoupled({ seconds: 0.5 });

  assert.equal(run.intervals, Math.round(0.5 / COUPLING_SECONDS));
  assert.ok(parts.physicsService.describe(wheel.id).rpm > 100, "the circuit's motor turned the wheel");
  assert.ok(parts.circuitService.perceive().conditions.now.speed > 1,
    "and the wheel it turned is what the circuit's sensors now read");
  // Both advanced by the same interval. Two clocks would make the readings
  // incomparable — a wheel speed from one beside a firmware decision from the
  // other is two different experiments.
  assert.ok(Math.abs(parts.physicsService.perceive().elapsedSeconds - run.seconds) < 0.02);
});

test("a coupled run needs something linked, and a world to link to", async (t) => {
  const parts = await bench(t);
  drivenWheel(parts);
  assert.throws(() => parts.bench.runCoupled({ seconds: 0.1 }), (error) => error.code === "LINK_NONE");

  const loose = new BenchService({ database: parts.database, circuitService: parts.circuitService });
  loose.link({ kind: "speed", body: "nothing" });
  assert.throws(() => loose.runCoupled({ seconds: 0.1 }), (error) => error.code === "CAPABILITY_UNAVAILABLE");
});

test("a coupled run is a run, so the board records that it ran", async (t) => {
  const parts = await bench(t);
  const wheel = drivenWheel(parts);
  parts.bench.link({ kind: "spin", part: "M1", body: wheel.id });
  const board = parts.bench.save({ name: "Driven wheel", intent: "Spin a wheel from the board" });

  parts.bench.runCoupled({ seconds: 0.2 });

  const simulate = parts.bench.get(board.id).stages.find((stage) => stage.id === "simulate");
  assert.equal(simulate.state, "done");
  assert.match(simulate.headline, /^Ran 200ms/);
});

test("a speed the world refuses surfaces the world's own message", async (t) => {
  // A bare catch here reported "is not a motor" for a speed that was merely out
  // of range — a fabricated diagnosis in place of an accurate one, which is the
  // fault that cost this project a whole incident report.
  const parts = await bench(t);
  drivenWheel(parts);
  const box = parts.physicsService.addBox({ x: 400, y: 200 });
  parts.bench.link({ kind: "spin", part: "M1", body: box.id });

  const run = parts.bench.runCoupled({ seconds: 0.05 });
  // Two distinct faults over three intervals, each said once: the world refused
  // the speed, and the motor is faster than the world can turn anyway.
  assert.equal(run.problems.length, 2);
  assert.match(run.problems.find((line) => line.startsWith(`${box.id}:`)),
    new RegExp(`^${box.id}: .*is not a motor`),
    "the world says what is wrong with it; the bench does not guess");
  assert.equal(run.problems.filter((line) => line.includes("tops out near")).length, 1,
    "one saturating link is one line, however many intervals it saturates for");
});
