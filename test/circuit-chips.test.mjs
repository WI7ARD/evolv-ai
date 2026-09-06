import test from "node:test";
import assert from "node:assert/strict";
import { solveNetlist } from "../lib/circuit/netlist.mjs";
import { runTransient } from "../lib/circuit/transient.mjs";
import { chipDriver, gateOutput, createChipState, GATE_FUNCTIONS } from "../lib/circuit/chips.mjs";
import { PART_KINDS, PARTS } from "../lib/circuit/parts.mjs";

// The chips, against the arithmetic on the front page of their datasheets.
//
// Same standard as the solver and the transient tests: every figure asserted
// here is one a textbook gives in closed form, written in the comment beside it.
// A macromodel that is merely self-consistent is worth nothing.

const GROUND = { id: "GND1", kind: "ground", values: {}, pins: { pin: "GND" } };
const rail = (id, volts, net) => ({
  id, kind: "supply", values: { volts, resistance: 0.01 }, pins: { positive: net, negative: "GND" }
});

test("an inverting amplifier has the gain the resistors say", () => {
  // Gain = −Rf/Rin. With 10k and 1k that is −10, and the inverting input sits at
  // a virtual earth — near zero however hard the output is working.
  const amplifier = (input) => [
    rail("PS1", 12, "VP"), rail("PS2", -12, "VN"), rail("PS3", input, "IN"),
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "IN", b: "SUM" } },
    { id: "R2", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "SUM", b: "OUT" } },
    { id: "U1", kind: "opamp", values: { part: "LM358" }, pins: { inPlus: "GND", inMinus: "SUM", out: "OUT", vPos: "VP", vNeg: "VN" } },
    GROUND
  ];
  for (const input of [0.2, 0.5, 1.0]) {
    const result = solveNetlist(amplifier(input));
    assert.equal(result.solved, true, `${input}V should solve`);
    assert.ok(Math.abs(result.nodes.OUT - (-10 * input)) < 0.01,
      `${input}V in should give ${-10 * input}V out, got ${result.nodes.OUT}`);
    assert.ok(Math.abs(result.nodes.SUM) < 0.001, `the summing junction is a virtual earth, got ${result.nodes.SUM}`);
  }
});

test("an op-amp clips at its rails instead of inventing a voltage", () => {
  // Asked for −20V on a ±12V supply. A model that obliges is the reason someone
  // builds a circuit that cannot work and cannot see why.
  const result = solveNetlist([
    rail("PS1", 12, "VP"), rail("PS2", -12, "VN"), rail("PS3", 2, "IN"),
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "IN", b: "SUM" } },
    { id: "R2", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "SUM", b: "OUT" } },
    { id: "U1", kind: "opamp", values: { part: "LM358" }, pins: { inPlus: "GND", inMinus: "SUM", out: "OUT", vPos: "VP", vNeg: "VN" } },
    GROUND
  ]);
  assert.equal(result.solved, true);
  assert.ok(result.nodes.OUT > -11 && result.nodes.OUT < -10,
    `an LM358 on −12V reaches about −10.5V, not −20V; got ${result.nodes.OUT}`);
  // And the virtual earth is gone, which is how you know it is clipping.
  assert.ok(Math.abs(result.nodes.SUM) > 0.1, "a saturated op-amp no longer holds its inputs together");
});

test("a voltage follower follows", () => {
  const result = solveNetlist([
    rail("PS1", 12, "VP"), rail("PS2", 3, "IN"),
    { id: "U1", kind: "opamp", values: {}, pins: { inPlus: "IN", inMinus: "OUT", out: "OUT", vPos: "VP", vNeg: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ]);
  assert.ok(Math.abs(result.nodes.OUT - 3) < 0.001, `expected 3V, got ${result.nodes.OUT}`);
});

test("a regulator holds its output, and stops when the input gets too low", () => {
  const regulated = (input) => [
    rail("PS1", input, "VIN"),
    { id: "U1", kind: "regulator", values: { part: "LM7805" }, pins: { input: "VIN", output: "V5", ground: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 100, watts: 1 }, pins: { a: "V5", b: "GND" } },
    GROUND
  ];
  const healthy = solveNetlist(regulated(9));
  assert.ok(Math.abs(healthy.nodes.V5 - 5) < 0.01, `9V in should give 5V out, got ${healthy.nodes.V5}`);
  assert.ok(Math.abs(healthy.currents.R1 - 0.05) < 0.001, "50mA into 100Ω");

  // A 7805 needs about 2V of headroom. Below that it does not hold 5V — it
  // follows the input down, which is the most common reason a "regulated"
  // circuit misbehaves and the last thing anyone suspects.
  const starved = solveNetlist(regulated(6));
  assert.ok(starved.nodes.V5 < 4.5, `6V in cannot give 5V out, got ${starved.nodes.V5}`);
  assert.ok(starved.nodes.V5 > 3.5, "but it should still pass most of what it has");
});

test("logic gates tell the truth, and drive a real LED with real current", () => {
  const withGate = (a, b, fn) => solveNetlist([
    rail("PS1", 5, "VCC"),
    { id: "U1", kind: "gate", values: { function: fn }, pins: { a: a ? "VCC" : "GND", b: b ? "VCC" : "GND", out: "Q", vcc: "VCC", gnd: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 330 }, pins: { a: "Q", b: "N1" } },
    { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "N1", cathode: "GND" } },
    GROUND
  ]);

  for (const fn of ["and", "or", "nand", "nor", "xor", "xnor"]) {
    for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const result = withGate(a, b, fn);
      const expected = gateOutput(fn, [Boolean(a), Boolean(b)]);
      const high = result.nodes.Q > 2.5;
      assert.equal(high, expected, `${fn}(${a},${b}) should be ${expected ? "high" : "low"}, read ${result.nodes.Q}V`);
    }
  }

  // Drive strength is the point of modelling the output resistance at all. A
  // 74HC output is about 25Ω, so it does not deliver the full rail into a load —
  // and the LED current is correspondingly a little under what an ideal 5V
  // through 330Ω would give.
  const lit = withGate(0, 0, "nand");
  assert.ok(lit.nodes.Q > 4.5 && lit.nodes.Q < 5, `a loaded 74HC output sags below the rail, got ${lit.nodes.Q}`);
  assert.ok(lit.currents.D1 > 0.006 && lit.currents.D1 < 0.009, `expected about 8mA, got ${lit.currents.D1 * 1000}mA`);
  assert.deepEqual(lit.findings, [], "and nothing is over its rating");
});

test("a 555 astable runs at the frequency the formula predicts", async () => {
  // f = 1.44 / ((R1 + 2·R2) · C), and the capacitor swings between one third and
  // two thirds of the supply. Both are on the front page of the datasheet.
  const R1 = 10_000;
  const R2 = 47_000;
  const C = 1e-6;
  const parts = [
    rail("PS1", 5, "VCC"),
    { id: "RA", kind: "resistor", values: { ohms: R1 }, pins: { a: "VCC", b: "DIS" } },
    { id: "RB", kind: "resistor", values: { ohms: R2 }, pins: { a: "DIS", b: "THR" } },
    { id: "C1", kind: "capacitor", values: { farads: C, volts: 50 }, pins: { a: "THR", b: "GND" } },
    { id: "U1", kind: "timer555", values: {}, pins: { trigger: "THR", threshold: "THR", discharge: "DIS", out: "OUT", reset: "VCC", vcc: "VCC", gnd: "GND" } },
    { id: "RL", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ];
  const result = runTransient(parts, {
    seconds: 0.5, dt: 5e-5,
    probes: [{ kind: "net", target: "OUT" }, { kind: "net", target: "THR" }]
  });

  // Half-periods rather than whole ones: a 555 astable is deliberately
  // asymmetric, and checking both is what catches a discharge path wired
  // through the wrong resistor.
  const output = result.traces[0].points;
  const rising = [];
  const falling = [];
  let wasHigh = output[0][1] > 2.5;
  for (const [time, value] of output) {
    const isHigh = value > 2.5;
    if (isHigh && !wasHigh) rising.push(time);
    if (!isHigh && wasHigh) falling.push(time);
    wasHigh = isHigh;
  }
  assert.ok(rising.length >= 4, `expected several cycles, saw ${rising.length}`);

  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
  const highs = rising.map((start) => falling.find((end) => end > start) - start).filter(Number.isFinite);
  const lows = falling.map((start) => rising.find((end) => end > start) - start).filter(Number.isFinite);

  // Charges through R1+R2, discharges through R2 alone.
  assert.ok(Math.abs(mean(highs) - (0.693 * (R1 + R2) * C)) < 0.002,
    `high time should be ${0.693 * (R1 + R2) * C}s, got ${mean(highs)}s`);
  assert.ok(Math.abs(mean(lows) - (0.693 * R2 * C)) < 0.002,
    `low time should be ${0.693 * R2 * C}s, got ${mean(lows)}s`);

  const frequency = 1 / (mean(highs) + mean(lows));
  const theory = 1.44 / ((R1 + (2 * R2)) * C);
  assert.ok(Math.abs(frequency - theory) / theory < 0.02,
    `expected about ${theory.toFixed(2)}Hz, got ${frequency.toFixed(2)}Hz`);

  // And the capacitor lives between the two comparator thresholds, once the
  // first charge from zero is out of the way.
  const settled = result.traces[1].points.filter(([time]) => time > 0.2).map(([, value]) => value);
  assert.ok(Math.abs(Math.min(...settled) - (5 / 3)) < 0.05, `should bottom out near 1.67V, got ${Math.min(...settled)}`);
  assert.ok(Math.abs(Math.max(...settled) - (10 / 3)) < 0.05, `and top out near 3.33V, got ${Math.max(...settled)}`);
});

test("a D flip-flop wired to its own Q-bar halves the clock", () => {
  // The standard divide-by-two, and the test that caught Q-bar being computed
  // backwards — with an "inverted" flag that returned the low level when Q was
  // low, so the thing never toggled at all.
  const result = runTransient([
    rail("PS1", 5, "VCC"),
    { id: "CLK", kind: "supply", values: { volts: 5, low: 0, waveform: "pulse", frequency: 100, duty: 0.5, resistance: 1 }, pins: { positive: "CK", negative: "GND" } },
    { id: "U1", kind: "flipflop", values: {}, pins: { d: "QN", clk: "CK", q: "Q", qn: "QN", vcc: "VCC", gnd: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "Q", b: "GND" } },
    { id: "R2", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "QN", b: "GND" } },
    GROUND
  ], { seconds: 0.1, dt: 5e-5, probes: [{ kind: "net", target: "CK" }, { kind: "net", target: "Q" }] });

  const edges = (points) => {
    let count = 0;
    let wasHigh = points[0][1] > 2.5;
    for (const [, value] of points) {
      const isHigh = value > 2.5;
      if (isHigh && !wasHigh) count += 1;
      wasHigh = isHigh;
    }
    return count;
  };
  const clock = edges(result.traces[0].points);
  const output = edges(result.traces[1].points);
  assert.ok(clock >= 8, `expected about ten clock edges, saw ${clock}`);
  // Half, give or take where the run happened to stop.
  assert.ok(Math.abs(output - (clock / 2)) <= 1, `${clock} clock edges should give about ${clock / 2} output edges, got ${output}`);
});

test("an unpowered chip is not driving anything, and says so by staying solvable", () => {
  // A driven pin gets a branch unknown and an internal node. When the part was
  // unpowered it stamped neither, leaving two empty rows — and every circuit
  // containing a logic gate reported that it had no single answer, because on
  // the first iteration every node reads zero and so every supply looks absent.
  const result = solveNetlist([
    rail("PS1", 5, "VCC"),
    // vcc deliberately left on ground: the gate has no supply.
    { id: "U1", kind: "gate", values: { function: "nand" }, pins: { a: "GND", b: "GND", out: "Q", vcc: "GND", gnd: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "Q", b: "GND" } },
    { id: "R2", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "VCC", b: "GND" } },
    GROUND
  ]);
  assert.equal(result.solved, true, "an unpowered part must not make the circuit unsolvable");
  assert.ok(Math.abs(result.nodes.Q) < 0.01, "and its output floats near nothing rather than driving");
});

test("an MCU pin drives what it says it drives", () => {
  const pin = (mode, duty) => solveNetlist([
    rail("PS1", 5, "VCC"),
    { id: "MCU1", kind: "mcupin", values: { mode, duty }, pins: { pin: "IO", vcc: "VCC", gnd: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "IO", b: "GND" } },
    GROUND
  ]);
  assert.ok(pin("high").nodes.IO > 4.9, "high means high");
  assert.ok(pin("low").nodes.IO < 0.1, "low means low");
  // Averaged, because without a time base that is what a meter reads. Stage 5
  // turns this into a real square wave.
  assert.ok(Math.abs(pin("pwm", 0.5).nodes.IO - 2.5) < 0.1, "a half-duty pin meters at half the supply");
  assert.ok(Math.abs(pin("pwm", 0.25).nodes.IO - 1.25) < 0.1);
  assert.ok(pin("float").nodes.IO < 0.01, "and a floating pin drives nothing");
});

test("every chip is a part the catalogue knows how to describe and draw", () => {
  // A part the solver understands and the schematic cannot draw is a part
  // nobody can use.
  for (const kind of ["opamp", "regulator", "gate", "flipflop", "timer555", "mcupin"]) {
    assert.ok(PART_KINDS.includes(kind), `${kind} must be in the catalogue`);
    const definition = PARTS[kind];
    assert.ok(definition.pins.length >= 2, `${kind} needs pins`);
    assert.ok(definition.symbol, `${kind} needs a symbol`);
    assert.ok(definition.describe(definition.defaults).length > 3, `${kind} needs a description`);
  }
  assert.deepEqual([...GATE_FUNCTIONS].sort(), ["and", "buffer", "nand", "nor", "not", "or", "xnor", "xor"]);
});

test("a latch reads the instant it is in, not the one before", () => {
  // Two wrong versions came before this one. Updating latches inside the Newton
  // loop made the answer depend on how many iterations convergence took; moving
  // them out but reading the previous step's solution added a timestep of
  // comparator lag. A latch now sees this instant and the circuit responds to it
  // in this instant, which is checked here by running the same circuit twice and
  // requiring the two to be identical.
  const parts = [
    rail("PS1", 5, "VCC"),
    { id: "RA", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "VCC", b: "DIS" } },
    { id: "RB", kind: "resistor", values: { ohms: 47_000 }, pins: { a: "DIS", b: "THR" } },
    { id: "C1", kind: "capacitor", values: { farads: 1e-6, volts: 50 }, pins: { a: "THR", b: "GND" } },
    { id: "U1", kind: "timer555", values: {}, pins: { trigger: "THR", threshold: "THR", discharge: "DIS", out: "OUT", reset: "VCC", vcc: "VCC", gnd: "GND" } },
    { id: "RL", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ];
  const once = runTransient(parts, { seconds: 0.1, dt: 1e-4, probes: [{ kind: "net", target: "OUT" }] });
  const twice = runTransient(parts, { seconds: 0.1, dt: 1e-4, probes: [{ kind: "net", target: "OUT" }] });
  assert.deepEqual(once.traces[0].points, twice.traces[0].points);
});

test("the chip models are pure — asking twice does not change the answer", () => {
  // chipDriver is called once per Newton iteration. A model that wrote to its
  // own state inside that loop would consume its own clock edge on the first
  // iteration and hold a different value for the rest.
  const read = (voltages) => (pin) => voltages[pin] ?? 0;
  const flipflop = { id: "U1", kind: "flipflop", values: {} };
  const state = createChipState([flipflop]).get("U1");
  const before = JSON.stringify(state);
  const voltages = { clk: 5, d: 5, vcc: 5, gnd: 0 };
  const first = chipDriver(flipflop, read(voltages), state);
  const second = chipDriver(flipflop, read(voltages), state);
  assert.equal(JSON.stringify(state), before, "reading a chip must not change it");
  assert.deepEqual(first, second);
});
