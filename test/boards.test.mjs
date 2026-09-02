import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { CircuitService } from "../lib/circuit.mjs";
import { BenchService } from "../lib/bench.mjs";
import { stageReport, designFingerprint, compareMeasurement, normaliseMeasurement, boardSummary } from "../lib/boards.mjs";

// A board is a design plus the record of what has happened to it. Almost every
// test here is about the same property in a different place: the record has to
// be about *this* design, and has to say so when it stops being.

function design(overrides = {}) {
  return {
    version: 1,
    components: [
      { id: "PS1", kind: "supply", values: { volts: 5 }, pins: { positive: "VCC", negative: "GND" } },
      { id: "R1", kind: "resistor", values: { ohms: 220 }, pins: { a: "VCC", b: "N1" } },
      { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "N1", cathode: "GND" } }
    ],
    firmware: {}, conditions: {}, expectations: [], probes: [],
    ...overrides
  };
}

async function bench(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-board-"));
  const database = createDatabase({ dataDir: root, dbPath: path.join(root, "b.db"), defaultPrompt: "test" });
  const circuitService = new CircuitService();
  // One hook, closing before deleting: Node runs after-hooks in registration
  // order, so two the other way round delete the file while SQLite holds it —
  // POSIX allows it, Windows answers EBUSY.
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  circuitService.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  circuitService.apply("add", { kind: "resistor", ohms: 220, pins: { a: "VCC", b: "N1" } });
  circuitService.apply("add", { kind: "led", colour: "red", pins: { anode: "N1", cathode: "GND" } });
  circuitService.apply("add", { kind: "ground", pins: { pin: "GND" } });
  return { database, circuitService, bench: new BenchService({ database, circuitService }) };
}

test("a fingerprint is about the design, not the order it was typed in", () => {
  const forwards = design();
  const backwards = design({ components: [...design().components].reverse() });
  assert.equal(
    designFingerprint(forwards, ["components"]),
    designFingerprint(backwards, ["components"]),
    "adding the same two parts in the other order is the same board"
  );
  const changed = design({
    components: design().components.map((part) => (part.id === "R1" ? { ...part, values: { ohms: 470 } } : part))
  });
  assert.notEqual(designFingerprint(forwards, ["components"]), designFingerprint(changed, ["components"]),
    "but a different resistor is a different board");
});

test("a stage goes stale only when the part of the design it judged moves", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "Blinker", intent: "Blink an LED" });
  circuitService.apply("add", { kind: "mcu", pins: { vcc: "VCC", gnd: "GND", d0: "N1" } });
  circuitService.apply("firmware", { id: "U1", source: "pinMode(0, OUT)\nloop { digitalWrite(0, HIGH) }" });
  circuitService.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  workshop.save({});

  workshop.exportDesign({ format: "netlist" });
  workshop.record("verify", { passed: 1, failed: 0, results: [] });
  const stages = () => workshop.get(board.id).stages;
  assert.equal(stages().find((stage) => stage.id === "export").state, "done");
  assert.equal(stages().find((stage) => stage.id === "verify").state, "done");

  // A netlist does not contain the firmware, so editing the firmware cannot
  // make the netlist wrong. A verdict about how the board behaves can.
  circuitService.apply("firmware", { id: "U1", source: "pinMode(0, OUT)\nloop { digitalWrite(0, LOW) }" });
  assert.equal(stages().find((stage) => stage.id === "export").state, "done",
    "a staleness warning that fires on changes it does not depend on is one nobody reads");
  const verify = stages().find((stage) => stage.id === "verify");
  assert.equal(verify.state, "stale");
  assert.deepEqual(verify.changed, ["firmware"], "and it names what moved, so you know which one to re-run");

  // A part change reaches both.
  circuitService.apply("adjust", { id: "R1", ohms: 470 });
  assert.equal(stages().find((stage) => stage.id === "export").state, "stale");
});

test("what a stage reads is derived from the design, never from what it was told", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "LED", intent: "Light one LED" });
  const stages = () => workshop.get(board.id).stages;

  assert.equal(stages().find((stage) => stage.id === "design").headline, "4 parts");
  assert.equal(stages().find((stage) => stage.id === "specify").state, "pending");

  circuitService.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  assert.equal(stages().find((stage) => stage.id === "specify").headline, "1 expectation",
    "a board cannot claim an expectation it does not hold, or forget one it does");

  circuitService.apply("remove", { id: "D1" });
  assert.equal(stages().find((stage) => stage.id === "design").headline, "3 parts");
});

test("the open board is read against the bench, so an unsaved change reads as stale", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "LED" });
  workshop.exportDesign({ format: "netlist" });
  assert.equal(workshop.get(board.id).stages.find((stage) => stage.id === "export").state, "done");

  circuitService.apply("adjust", { id: "R1", ohms: 470 });
  const stale = workshop.get(board.id).stages.find((stage) => stage.id === "export");
  assert.equal(stale.state, "stale", "the netlist on disk no longer describes the circuit on the bench");
  assert.deepEqual(stale.changed, ["components"]);
  assert.match(workshop.summary(), /out of date/);

  // Closed, the board is read against what was actually saved.
  workshop.close();
  assert.equal(workshop.get(board.id).stages.find((stage) => stage.id === "export").state, "done");
});

test("running, checking and exporting write themselves down; nothing else has to remember to", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "LED", intent: "Light one LED off 5V" });
  circuitService.apply("expect", { subject: "D1", measure: "current", condition: "reaches", value: 0.01 });

  workshop.run({ seconds: 0.002 });
  workshop.check({ seconds: 0.002 });
  workshop.exportDesign({ format: "netlist" });

  const stages = workshop.get(board.id).stages;
  assert.equal(stages.find((stage) => stage.id === "simulate").state, "done");
  assert.match(stages.find((stage) => stage.id === "simulate").headline, /from the supply/);
  assert.equal(stages.find((stage) => stage.id === "verify").headline, "Its one expectation met");
  assert.equal(stages.find((stage) => stage.id === "export").headline, "LED.net",
    "the file is named after the board, because that is what it belongs to");
});

test("with no board open there is nothing to record, and that is allowed", async (t) => {
  const { bench: workshop } = await bench(t);
  assert.equal(workshop.openBoardId, null);
  assert.equal(workshop.summary(), "No board is open.");
  // A scratch circuit is how most boards start. Refusing to run one until it
  // had a name would make the sandbox worse to use to make its books tidier.
  assert.equal(workshop.run({ seconds: 0.001 }).ran, true);
  assert.equal(workshop.record("simulate", { seconds: 1 }), null);
  assert.throws(() => workshop.measure({ subject: "D1", measure: "current", value: 0.013 }),
    (error) => error.code === "BOARD_NONE_OPEN");
});

test("saving updates the board rather than forking it, unless asked", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const first = workshop.save({ name: "LED", intent: "Light one LED" });
  circuitService.apply("adjust", { id: "R1", ohms: 470 });
  const again = workshop.save({});
  assert.equal(again.id, first.id, "the ordinary press of Save must not leave LED, LED 2 and LED final");
  assert.equal(again.intent, "Light one LED", "and must not wipe what the board is for");
  assert.equal(workshop.list().length, 1);

  const forked = workshop.save({ name: "LED bright", asNew: true });
  assert.notEqual(forked.id, first.id);
  assert.equal(workshop.list().length, 2);
});

test("opening a board puts its design back on the bench", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "LED" });
  circuitService.apply("clear", {});
  assert.equal(circuitService.perceive().counts.parts, 0);

  workshop.open(board.id);
  assert.equal(circuitService.perceive().counts.parts, 4,
    "open has to mean the same thing to a person and to a model: this circuit, now");
  assert.equal(workshop.openBoardId, board.id);
  assert.throws(() => workshop.open("nope"), (error) => error.code === "BOARD_NOT_FOUND");
});

test("a bench reading is compared against the simulation, with both numbers shown", async (t) => {
  const { bench: workshop, circuitService } = await bench(t);
  const board = workshop.save({ name: "LED" });
  circuitService.apply("expect", { subject: "D1", measure: "current", condition: "reaches", value: 0.01 });
  workshop.check({ seconds: 0.002 });

  const close = workshop.measure({ subject: "D1", measure: "current", value: 0.0134, note: "bench meter" });
  const reading = close.measurements[0];
  assert.equal(reading.agreement, "agrees");
  assert.match(reading.detail, /^Simulated .*, measured 13\.40mA/);
  assert.equal(close.stages.find((stage) => stage.id === "measure").state, "done");

  const off = workshop.measure({ subject: "D1", measure: "current", value: 0.004 });
  assert.equal(off.measurements[0].agreement, "differs");
  assert.match(off.measurements[0].detail, /below/);

  // Something never checked has nothing to compare against, and says exactly
  // that rather than reporting a difference from zero.
  const unknown = workshop.measure({ subject: "PS1", measure: "current", value: 0.0175 });
  const unchecked = unknown.measurements.find((entry) => entry.subject === "PS1");
  assert.equal(unchecked.agreement, "unchecked");
  assert.equal(unchecked.simulated, null);
  assert.match(unchecked.detail, /nothing to compare it against/);

  assert.throws(() => workshop.measure({ subject: "D1", measure: "temperature", value: 20 }),
    (error) => error.code === "BOARD_MEASURE_UNKNOWN");
  assert.throws(() => workshop.measure({ subject: "D1", measure: "current", value: "hot" }),
    (error) => error.code === "BOARD_MEASURE_VALUE");
  assert.ok(board.id);
});

test("what the cloud cost lands on the board it was spent on", async (t) => {
  const { bench: workshop } = await bench(t);
  const board = workshop.save({ name: "LED" });
  workshop.spend(120_000);
  workshop.spend(190_000);
  assert.equal(workshop.get(board.id).spendMicros, 310_000);

  // A turn spent on something else is not this board's cost.
  workshop.close();
  assert.equal(workshop.spend(500_000), false);
  assert.equal(workshop.get(board.id).spendMicros, 310_000);
});

test("the summary names the furthest stage reached and the next one to do", () => {
  const snapshot = design();
  const board = { name: "LED", intent: "Light one LED", snapshot, stages: {}, measurements: [] };
  assert.match(boardSummary(board), /^Design: 3 parts\. Next: simulate\.$/);
  assert.equal(boardSummary({ ...board, intent: "", snapshot: { components: [] } }), "Nothing has been designed yet.");
});

test("a measurement is normalised before it is kept", () => {
  const entry = normaliseMeasurement({ subject: "  PS1  ", measure: "current", value: "0.0175", note: "x".repeat(500) });
  assert.equal(entry.subject, "PS1");
  assert.equal(entry.value, 0.0175);
  assert.equal(entry.note.length, 200);
  assert.ok(entry.measuredAt);
  assert.equal(compareMeasurement(entry, null).agreement, "unchecked");
});

test("stageReport always returns every stage, in order", () => {
  const report = stageReport({ snapshot: design(), stages: {}, measurements: [] });
  assert.deepEqual(report.map((stage) => stage.id), [
    "intent", "design", "simulate", "program", "specify", "verify", "export", "build", "measure"
  ], "the empty stages are what tell you where you are, so none of them may be hidden");
  assert.ok(report.every((stage) => ["pending", "done", "stale"].includes(stage.state)));
});
