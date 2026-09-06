import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  thermistorOhms, ldrOhms, wheelPulseHz, speedFromPulseHz, sensorView, SENSOR_KINDS
} from "../lib/circuit/sensors.mjs";
import { createConditions, normaliseCondition, conditionsAt, integrateCondition, describeConditions, QUANTITY_NAMES } from "../lib/circuit/conditions.mjs";
import { CircuitService } from "../lib/circuit.mjs";

// A sensor's whole job is to be right about the world, so these check the
// figures against the datasheets the parts are sold with rather than against
// whatever the code happens to produce.

test("a 10k NTC follows its own beta curve", () => {
  // A 10kΩ B=3950 thermistor, which is what is in every kit. The published
  // table gives about 32.7kΩ at 0°C, 12.5kΩ at 20°C, 10kΩ at 25°C by
  // definition, and 3.6kΩ at 50°C.
  assert.ok(Math.abs(thermistorOhms({}, 25) - 10_000) < 1, "10k at 25°C is the definition");
  assert.ok(Math.abs(thermistorOhms({}, 0) - 33_000) < 1_500, `0°C: ${thermistorOhms({}, 0)}`);
  assert.ok(Math.abs(thermistorOhms({}, 20) - 12_500) < 400, `20°C: ${thermistorOhms({}, 20)}`);
  assert.ok(Math.abs(thermistorOhms({}, 50) - 3_600) < 200, `50°C: ${thermistorOhms({}, 50)}`);
  // Negative coefficient means hotter is lower, which is the whole name.
  assert.ok(thermistorOhms({}, 60) < thermistorOhms({}, 10));
  // And a PTC goes the other way, because some parts do.
  assert.ok(thermistorOhms({ coefficient: "ptc" }, 60) > thermistorOhms({ coefficient: "ptc" }, 10));
});

test("a light sensor follows its power law, and has a real dark resistance", () => {
  assert.ok(Math.abs(ldrOhms({}, 10) - 10_000) < 1, "quoted at 10 lux");
  assert.ok(ldrOhms({}, 1000) < ldrOhms({}, 100), "brighter is lower");
  assert.ok(ldrOhms({}, 1000) > 100 && ldrOhms({}, 1000) < 500, `bright daylight: ${ldrOhms({}, 1000)}`);
  // In the dark it stops at the datasheet's dark resistance rather than running
  // to infinity, so a divider built with one still has a defined output there
  // instead of a floating pin.
  assert.equal(ldrOhms({}, 0), 1_000_000);
  assert.ok(ldrOhms({}, 0.0001) <= 1_000_000);
});

test("a wheel sensor's pulse rate is the speed, and converts back", () => {
  // 2096mm is what bike computers ship set to, and is a 700×23c tyre.
  assert.ok(Math.abs(wheelPulseHz({}, 30) - 3.976) < 0.01, `30km/h: ${wheelPulseHz({}, 30)}Hz`);
  assert.equal(wheelPulseHz({}, 0), 0, "a stopped wheel makes no pulses");
  // Round trip, because the firmware on the board has to do this sum and a test
  // that repeated the sum it was checking would prove nothing.
  for (const speed of [5, 12.5, 30, 60]) {
    assert.ok(Math.abs(speedFromPulseHz({}, wheelPulseHz({}, speed)) - speed) < 1e-9);
  }
  // Two magnets is twice the pulses at the same speed, and the conversion has
  // to know that or the board reads double.
  assert.ok(Math.abs(wheelPulseHz({ magnets: 2 }, 30) - (2 * wheelPulseHz({}, 30))) < 1e-9);
  assert.ok(Math.abs(speedFromPulseHz({ magnets: 2 }, wheelPulseHz({ magnets: 2 }, 30)) - 30) < 1e-9);
  // A smaller wheel turns more often for the same road speed.
  assert.ok(wheelPulseHz({ circumference: 1.6 }, 30) > wheelPulseHz({ circumference: 2.096 }, 30));
});

test("the world holds still, or ramps, and nothing else", () => {
  const conditions = createConditions();
  assert.equal(conditionsAt(conditions, 0).temperature, 20, "a bench is at room temperature");
  assert.equal(conditionsAt(conditions, 0).accelZ, 1, "and a board lying flat feels gravity");

  conditions.set("speed", normaliseCondition("speed", { from: 0, to: 30, seconds: 10 }));
  assert.equal(conditionsAt(conditions, 0).speed, 0);
  assert.equal(conditionsAt(conditions, 5).speed, 15);
  assert.equal(conditionsAt(conditions, 10).speed, 30);
  // Held at the far end rather than repeating: a ramp that looped would make a
  // run's answer depend on its length with nothing on screen explaining why.
  assert.equal(conditionsAt(conditions, 40).speed, 30);

  assert.throws(() => normaliseCondition("altitude", 100), /no such condition/);
  assert.throws(() => normaliseCondition("speed", "quickly"), /has to be a number/);
  assert.throws(() => normaliseCondition("speed", { from: 0, to: 30 }), /how long it takes/);
  assert.throws(() => normaliseCondition("speed", { from: 0, to: 30, seconds: -1 }), /how long it takes/);

  // Only what was moved is recited; a list that always names all six buries the
  // one that was changed.
  const rested = createConditions();
  assert.match(describeConditions(rested), /still, at room temperature/);
  rested.set("temperature", normaliseCondition("temperature", 40));
  assert.equal(describeConditions(rested), "temperature 40°C");
});

// The parts in a circuit, which is where the arithmetic above has to survive
// contact with a solver.

const board = () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 10_000, pins: { a: "VCC", b: "TEMP" } });
  service.apply("add", { kind: "thermistor", pins: { a: "TEMP", b: "GND" } });
  service.apply("add", { kind: "hall", pins: { out: "SPD", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "accelerometer", pins: { x: "AX", y: "AY", z: "AZ", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "SPD", a0: "TEMP", a1: "AX", a2: "AY", a3: "AZ", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  return service;
};

test("a thermistor divider moves with the temperature", () => {
  const service = board();
  const at = (celsius) => {
    service.apply("conditions", { temperature: celsius });
    return service.perceive();
  };
  // 10k top, NTC bottom: colder means a higher thermistor and a higher tap.
  const cold = at(0).nets.TEMP;
  const warm = at(20).nets.TEMP;
  const hot = at(40).nets.TEMP;
  assert.ok(cold > warm && warm > hot, `${cold} / ${warm} / ${hot}`);
  // 12.5k against 10k on a 5V rail is 2.78V, which is a number anyone can check.
  assert.ok(Math.abs(warm - 2.78) < 0.03, `20°C should tap about 2.78V, got ${warm}`);
  // And the reading is the temperature, not the voltage. A part that could only
  // report volts would make the person do the thermistor's arithmetic.
  assert.match(at(12).sensors.RT1.reading, /12°C/);
});

test("a wheel sensor pulses at the speed it is going", () => {
  const service = board();
  service.apply("conditions", { speed: 30 });
  service.apply("probe", { target: "SPD" });
  const run = service.apply("run", { seconds: 2, dt: 1e-3 });
  assert.deepEqual(run.findings, [], "a sensor into an MCU pin is a complete circuit");

  let edges = 0;
  let wasHigh = false;
  for (const [, value] of run.traces[0].points) {
    const isHigh = value > 2.5;
    if (isHigh && !wasHigh) edges += 1;
    wasHigh = isHigh;
  }
  // 3.976Hz for two seconds.
  assert.ok(edges >= 7 && edges <= 9, `expected about 8 pulses in two seconds, counted ${edges}`);

  // Stopped is stopped, not a slow blink.
  const stopped = board();
  stopped.apply("probe", { target: "SPD" });
  const still = stopped.apply("run", { seconds: 2, dt: 1e-3 });
  const values = still.traces[0].points.map(([, value]) => value);
  assert.ok(Math.max(...values) - Math.min(...values) < 0.1, "a stationary wheel makes no edges");
  assert.equal(stopped.perceive().sensors.U1.reading, "stopped");
});

test("an accelerometer sits at half the rail and moves ratiometrically", () => {
  const service = board();
  service.apply("conditions", { accelX: 0, accelY: 0, accelZ: 0 });
  const level = service.perceive();
  assert.ok(Math.abs(level.nets.AX - 2.5) < 0.01, `zero g is half the supply, got ${level.nets.AX}`);

  // 0.1 of the supply per g: on 5V that is 500mV/g.
  service.apply("conditions", { accelX: 1, accelZ: -1 });
  const tilted = service.perceive();
  assert.ok(Math.abs(tilted.nets.AX - 3.0) < 0.02, `1g should read 3.0V, got ${tilted.nets.AX}`);
  assert.ok(Math.abs(tilted.nets.AZ - 2.0) < 0.02, `-1g should read 2.0V, got ${tilted.nets.AZ}`);

  // And it cannot report more than it can measure. A part asked for 10g on a
  // ±3g range pins at its limit, which is what the real one does and is the
  // reason a crash trace looks flat-topped.
  service.apply("conditions", { accelX: 10 });
  const slammed = service.perceive();
  assert.ok(slammed.nets.AX < 4.1, `a ±3g part cannot report 10g, read ${slammed.nets.AX}`);
  assert.ok(Math.abs(slammed.nets.AX - 4.0) < 0.05, `it should pin at 3g, read ${slammed.nets.AX}`);
});

test("a ramp is a ride, and the sensors follow it through the run", () => {
  // The question these exist to answer: does the board read the right speed
  // while it accelerates. A constant cannot ask it.
  const service = board();
  service.apply("conditions", { speed: { from: 0, to: 40, seconds: 10 } });
  service.apply("probe", { target: "SPD" });
  const run = service.apply("run", { seconds: 10, dt: 2e-3 });
  assert.equal(run.ran, true);

  // Pulses get closer together as it speeds up: count them in the first half
  // and the second, and the second must be busier.
  const edgesBetween = (from, until) => {
    let edges = 0;
    let wasHigh = false;
    for (const [at, value] of run.traces[0].points) {
      const isHigh = value > 2.5;
      if (at >= from && at <= until && isHigh && !wasHigh) edges += 1;
      wasHigh = isHigh;
    }
    return edges;
  };
  const early = edgesBetween(0, 5);
  const late = edgesBetween(5, 10);
  assert.ok(late > early * 2, `accelerating should pulse faster: ${early} then ${late}`);
  // And the world reports where it got to, not where it started.
  assert.equal(service.perceive().conditions.now.speed, 40);
});

test("what the sensor reads and what the board can read are checked separately", () => {
  // An expectation about a sensor's own voltage is the honest way to check a
  // front end: the reading is what the part knows, the voltage is what the
  // circuit downstream of it actually gets, and a divider with the wrong
  // resistor breaks the second while the first stays perfect.
  const service = board();
  service.apply("conditions", { temperature: 20 });
  service.apply("expect", { subject: "TEMP", measure: "voltage", condition: "stays between", value: 2.7, upper: 2.9 });
  const report = service.apply("check", { seconds: 0.1, dt: 1e-3 });
  assert.equal(report.failed, 0, report.results[0]?.detail);

  // The same board in the cold falls out of the window, and says by how much.
  service.apply("conditions", { temperature: -10 });
  const cold = service.apply("check", { seconds: 0.1, dt: 1e-3 });
  assert.equal(cold.failed, 1);
  assert.match(cold.results[0].detail, /above the band, to 4\.2/, cold.results[0].detail);
});

test("an unpowered sensor drives nothing, and says nothing untrue", () => {
  // A chip with no supply is a part with legs. The failure to avoid is a sensor
  // that reports a confident reading from a board that is switched off.
  const service = new CircuitService();
  service.apply("add", { kind: "hall", pins: { out: "SPD", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 10_000, pins: { a: "SPD", b: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 10_000, pins: { a: "VCC", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("conditions", { speed: 30 });
  const view = service.perceive();
  assert.equal(view.solved, true, JSON.stringify(view.findings));
  assert.ok(Math.abs(view.nets.SPD) < 0.01, `an unpowered sensor drives nothing, read ${view.nets.SPD}`);
});

test("the world reopens with the circuit", () => {
  const service = board();
  service.apply("conditions", { temperature: 35, speed: { from: 0, to: 25, seconds: 8 } });
  const snapshot = service.snapshot();

  const reopened = new CircuitService();
  reopened.restore(snapshot);
  const conditions = reopened.perceive().conditions;
  assert.equal(conditions.now.temperature, 35);
  assert.equal(conditions.settings.speed.to, 25);
  assert.match(conditions.description, /road speed 0km\/h to 25km\/h over 8s/);
  // A board reopened at a temperature it was never designed for would be a
  // different experiment wearing the same name.
  assert.ok(Math.abs(reopened.perceive().nets.TEMP - service.perceive().nets.TEMP) < 1e-9);
});

test("changing the world throws away the run that happened in the old one", () => {
  const service = board();
  service.apply("probe", { target: "TEMP" });
  service.apply("run", { seconds: 0.05, dt: 1e-3 });
  assert.ok(service.perceive().elapsedSeconds > 0);
  service.apply("conditions", { temperature: 40 });
  assert.equal(service.perceive().elapsedSeconds, 0,
    "the traces on screen were recorded somewhere else");
});

test("every sensor is drawn, designated, and readable", async () => {
  // The same three invariants the chips needed, for the same reason: a part the
  // renderer cannot draw falls back to a resistor, and one with no designator
  // cannot be ordered.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const drawn = new Set([...script.matchAll(/^ {2}([a-z0-9]+): "M/gm)].map((match) => match[1]));
  const service = new CircuitService();
  for (const kind of SENSOR_KINDS) {
    assert.ok(drawn.has(kind), `${kind} has no symbol`);
    const added = service.apply("add", { kind });
    assert.match(added.id, /^[A-Z]+[0-9]+$/, `${kind} produced ${added.id}`);
    assert.ok(sensorView({ kind, values: {} }, createConditions(), 0)?.reading, `${kind} has no reading`);
  }
  // And the page shows what they read, without working any of it out.
  assert.match(script, /frame\.sensors/, "the page has to show the readings");
  const panel = script.slice(script.indexOf("function renderConditions"), script.indexOf("// Whether the circuit does"));
  assert.doesNotMatch(panel, /thermistorOhms|Math\.exp|Math\.pow/, "and must not compute any of them");
  for (const name of QUANTITY_NAMES) assert.ok(typeof name === "string" && name.length > 0);
});

test("an unused output is not a fault, but an unconnected chip leg still is", () => {
  // A three-axis accelerometer on a board that only reads two has a spare pin,
  // and nobody routes it. The pin still sits at a defined voltage with nothing
  // drawing from it, which is a working board — refusing to solve it would make
  // the commonest real wiring of this part impossible.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "accelerometer", pins: { x: "AX", y: "AY", z: "AZ", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "mcu", pins: { a0: "AX", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  const view = service.perceive();
  assert.equal(view.solved, true, JSON.stringify(view.findings));
  assert.equal(view.findings.filter((finding) => finding.code === "FLOATING_NET").length, 0,
    "AY and AZ are spare outputs, not faults");

  // A microcontroller's legs are the exception, on purpose: they are
  // bidirectional, so a wire to nowhere is far more likely an input someone
  // forgot to connect — which really is undefined, and really is worth saying.
  const stray = new CircuitService();
  stray.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  stray.apply("add", { kind: "mcu", pins: { d0: "NOWHERE", vcc: "VCC", gnd: "GND" } });
  stray.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "VCC", b: "GND" } });
  stray.apply("add", { kind: "ground", pins: { pin: "GND" } });
  assert.ok(stray.perceive().findings.some((finding) => finding.code === "FLOATING_NET" && finding.net === "NOWHERE"),
    "a microcontroller pin wired to nothing is still worth saying");
});

test("a wheel counts the distance ridden, not the speed times the clock", () => {
  // The bug this exists to keep out: phase is the integral of frequency, and a
  // sensor pulsing at "the current rate times the elapsed time" counts a rider
  // who accelerates from rest as though the whole ride had been at their final
  // speed. Pulling away from the lights, the board read about twice the
  // distance it had actually covered — and every number a bike computer shows
  // is downstream of that count.
  const conditions = createConditions();
  conditions.set("speed", normaliseCondition("speed", { from: 0, to: 32, seconds: 8 }));

  // The closed form against a numerical integral, including past the end of the
  // ramp where it holds.
  for (const until of [2, 4, 8, 12]) {
    let sum = 0;
    const steps = 20_000;
    for (let step = 0; step < steps; step += 1) {
      sum += conditionsAt(conditions, (step + 0.5) * (until / steps)).speed * (until / steps);
    }
    assert.ok(Math.abs(integrateCondition(conditions, "speed", until) - sum) < 1e-6,
      `${until}s: ${integrateCondition(conditions, "speed", until)} vs ${sum}`);
  }

  // And in a real circuit: 0 to 32km/h over eight seconds averages 16km/h, so
  // 35.6 metres, which is 17 turns of a 2096mm wheel.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "hall", pins: { out: "SPD", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "SPD", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("conditions", { speed: { from: 0, to: 32, seconds: 8 } });
  service.apply("probe", { target: "SPD" });
  const run = service.apply("run", { seconds: 8, dt: 5e-4 });

  let edges = 0;
  let wasHigh = false;
  for (const [, value] of run.traces[0].points) {
    const isHigh = value > 2.5;
    if (isHigh && !wasHigh) edges += 1;
    wasHigh = isHigh;
  }
  const metres = (16 / 3.6) * 8;
  const turns = metres / 2.096;
  assert.ok(Math.abs(edges - turns) <= 1.5, `${metres.toFixed(1)}m is ${turns.toFixed(2)} turns, counted ${edges}`);
  // Emphatically not the wrong answer, which would have been about double.
  assert.ok(edges < turns * 1.5, `counted ${edges}, which is the accelerating-rider bug back again`);
});

test("a sensor costs something to leave switched on", () => {
  // The same omission the microcontroller had, and it matters for the same
  // reason. A hall sensor watching for a magnet draws five milliamps whether or
  // not a magnet ever comes — a third of what the microcontroller costs, all
  // the time — and it is the first thing anyone switches off between readings
  // when a board has to last on a cell. Reported as the nanoamps its output pin
  // happened to be sourcing, it looked free.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "hall", pins: { out: "SPD", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "accelerometer", pins: { x: "AX", y: "AY", z: "AZ", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "SPD", a0: "AX", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });

  const drawn = Object.fromEntries(service.perceive().parts.map((part) => [part.id, part.amps]));
  assert.ok(Math.abs(drawn.U1 - 0.005) < 2e-4, `a hall sensor draws about 5mA, got ${drawn.U1}`);
  assert.ok(Math.abs(drawn.U2 - 0.00035) < 2e-5, `an accelerometer draws about 350µA, got ${drawn.U2}`);
  // And the supply delivers all of it — the whole budget, which is the figure
  // that decides what cell the board needs.
  const total = drawn.U1 + drawn.U2 + drawn.U3;
  assert.ok(Math.abs(drawn.PS1 - total) < 3e-4, `supply ${drawn.PS1} against loads ${total}`);
  assert.ok(drawn.PS1 > 0.015 && drawn.PS1 < 0.020, `a board like this is about 17mA, got ${drawn.PS1}`);
});

test("a part's caption cannot run into the one beside it", async () => {
  // Symbol captions are centred in a 60px box, so a long description does not
  // overflow tidily — it merges with its neighbour into one unreadable line,
  // which looks like a rendering fault rather than a long name. The full text
  // is still in the parts table, where there is room.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  assert.match(script, /shorten\(symbol\.label\)/, "the caption has to be trimmed to fit");

  const { PARTS, PART_KINDS } = await import("../lib/circuit/parts.mjs");
  for (const kind of PART_KINDS) {
    const described = PARTS[kind].describe(PARTS[kind].defaults);
    assert.ok(described.length <= 34, `${kind} describes itself in ${described.length} characters: "${described}"`);
  }
});
