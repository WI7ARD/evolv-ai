import test from "node:test";
import assert from "node:assert/strict";
import { solveNetlist, billOfMaterials, buildIndex, isGroundName } from "../lib/circuit/netlist.mjs";
import { nearestE12, formatOhms, formatAmps, formatFarads, partRatings, PART_KINDS } from "../lib/circuit/parts.mjs";

const GROUND = { id: "GND1", kind: "ground", values: {}, pins: { pin: "GND" } };
const supply = (volts = 5) => ({ id: "BT1", kind: "supply", values: { volts, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" } });

test("an LED behind a resistor lands where a bench meter would", () => {
  // 5V, 220Ω, red LED. On a real breadboard this reads about 2.1V across the
  // LED and 13mA round the loop. Both numbers come from the exponential, not
  // from a table, so they are asserted as the band a real part occupies.
  const circuit = [
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 220, watts: 0.25 }, pins: { a: "VCC", b: "N1" } },
    { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "N1", cathode: "GND" } },
    GROUND
  ];
  const result = solveNetlist(circuit);
  assert.equal(result.solved, true);
  assert.deepEqual(result.findings, [], "a correct circuit should have nothing to say about it");
  assert.ok(result.nodes.N1 > 1.9 && result.nodes.N1 < 2.3, `LED should sit near 2.1V, got ${result.nodes.N1}`);
  const milliamps = result.currents.D1 * 1000;
  assert.ok(milliamps > 11 && milliamps < 15, `expected about 13mA, got ${milliamps}`);

  // Kirchhoff: one loop, so every part carries the same current.
  assert.ok(Math.abs(result.currents.R1 - result.currents.D1) < 1e-9);
  assert.ok(Math.abs(result.currents.BT1 - result.currents.D1) < 1e-9);
});

test("the mistake everyone makes once is named, not reported as unsolvable", () => {
  // An LED straight across 5V with no series resistor. This is *the* beginner
  // error, and it has to produce the sentence that explains it.
  //
  // It only works because sources carry internal resistance. With an ideal
  // source the current is around 10^42 amps, which makes the matrix numerically
  // degenerate, and the circuit reported "this has no single answer" — a matrix
  // complaint in place of the one lesson the sandbox exists to teach.
  const result = solveNetlist([
    supply(5),
    { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "VCC", cathode: "GND" } },
    GROUND
  ]);
  assert.equal(result.solved, true, "it must still solve — the answer is the point");
  const over = result.findings.find((finding) => finding.code === "OVER_CURRENT");
  assert.ok(over, `expected an over-current finding, got ${JSON.stringify(result.findings)}`);
  assert.match(over.message, /rated for 20mA/);
  assert.ok(result.currents.D1 > 1, "and the current should be an obviously destructive number");
});

test("a resistor past its wattage is called out with the figure", () => {
  // 12V across 100Ω is 1.44W in a quarter-watt part.
  const result = solveNetlist([
    { id: "BT1", kind: "supply", values: { volts: 12, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 100, watts: 0.25 }, pins: { a: "VCC", b: "GND" } },
    GROUND
  ]);
  const over = result.findings.find((finding) => finding.code === "OVER_POWER");
  assert.ok(over);
  assert.match(over.message, /1\.4[0-9]W/);
  assert.match(over.message, /0\.25W part/);
});

test("structural faults are reported instead of numbers", () => {
  // Each of these makes the arithmetic meaningless, so returning voltages
  // alongside them would be inventing an answer for a circuit that has none.
  const cases = [
    ["NO_GROUND", [
      { id: "BT1", kind: "supply", values: { volts: 5 }, pins: { positive: "A", negative: "B" } },
      { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "A", b: "B" } }
    ]],
    ["FLOATING_NET", [
      supply(5),
      { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "VCC", b: "NOWHERE" } },
      GROUND
    ]],
    ["SOURCE_SHORTED", [
      { id: "BT1", kind: "supply", values: { volts: 9 }, pins: { positive: "VCC", negative: "VCC" } },
      GROUND
    ]]
  ];
  for (const [code, circuit] of cases) {
    const result = solveNetlist(circuit);
    assert.equal(result.solved, false, `${code} should not produce numbers`);
    assert.deepEqual(result.nodes, {});
    assert.ok(result.findings.some((finding) => finding.code === code), `expected ${code}, got ${JSON.stringify(result.findings)}`);
  }
});

test("every finding says what it means on a bench, not what it means to a solver", () => {
  const result = solveNetlist([
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "VCC", b: "NOWHERE" } },
    GROUND
  ]);
  for (const finding of result.findings) {
    assert.ok(finding.message.length > 40, `a finding has to explain itself: ${finding.message}`);
    assert.doesNotMatch(finding.message, /matrix|singular|MNA|Newton/i,
      `findings are for the person building the circuit: ${finding.message}`);
  }
});

test("several ground symbols are one ground", () => {
  // On paper nobody would think otherwise, and every netlist tool has to say so.
  const result = solveNetlist([
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "VCC", b: "MID" } },
    { id: "R2", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "MID", b: "GND2" } },
    GROUND,
    { id: "GND2", kind: "ground", values: {}, pins: { pin: "GND2" } }
  ]);
  assert.equal(result.solved, true);
  assert.ok(Math.abs(result.nodes.MID - 2.5) < 0.01, `a divider between two grounds should read 2.5V, got ${result.nodes.MID}`);
  assert.ok(isGroundName("GND") && isGroundName("0") && isGroundName("ground"));
});

test("a potentiometer divides where its wiper is", () => {
  const at = (position) => solveNetlist([
    supply(10),
    { id: "RV1", kind: "potentiometer", values: { ohms: 10_000, position }, pins: { a: "VCC", wiper: "OUT", b: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 10_000_000 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ]).nodes.OUT;
  // Position is measured from the top, so 0.25 leaves a quarter of the track
  // above the wiper and three quarters below: 7.5V, not 2.5V.
  assert.ok(Math.abs(at(0.5) - 5) < 0.05, `centre should read 5V, got ${at(0.5)}`);
  assert.ok(at(0.25) > at(0.75), "turning the wiper one way has to move the voltage the other");
});

test("an open switch stops the circuit and a closed one does not", () => {
  const withSwitch = (closed) => solveNetlist([
    supply(5),
    { id: "SW1", kind: "switch", values: { closed }, pins: { a: "VCC", b: "N1" } },
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "N1", b: "GND" } },
    GROUND
  ]);
  const on = withSwitch(true);
  const off = withSwitch(false);
  assert.ok(Math.abs(on.currents.R1 - 0.005) < 1e-5, `closed should pass 5mA, got ${on.currents.R1}`);
  assert.ok(Math.abs(off.currents.R1) < 1e-7, `open should pass almost nothing, got ${off.currents.R1}`);
});

test("at rest a capacitor is open and an inductor is a wire", () => {
  // Not an approximation — it is what they are once nothing is changing, and it
  // is the answer a person would give without doing any arithmetic.
  const result = solveNetlist([
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "VCC", b: "N1" } },
    { id: "C1", kind: "capacitor", values: { farads: 1e-6, volts: 50 }, pins: { a: "N1", b: "GND" } },
    { id: "L1", kind: "inductor", values: { henries: 1e-3 }, pins: { a: "N1", b: "N2" } },
    { id: "R2", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "N2", b: "GND" } },
    GROUND
  ]);
  assert.equal(result.solved, true);
  assert.ok(Math.abs(result.currents.C1) < 1e-6, "no steady current flows through a capacitor");
  assert.ok(Math.abs(result.nodes.N1 - result.nodes.N2) < 1e-3, "an inductor drops nothing at DC");
  assert.ok(Math.abs(result.nodes.N1 - 2.5) < 0.01, "so this is just two 1k resistors in series");
});

test("node numbering depends on the circuit, not the order it was typed", () => {
  // Two identical circuits described in different orders must produce the same
  // matrix, or nothing downstream — snapshots, tests, saved scenes — is stable.
  const parts = [
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 220 }, pins: { a: "VCC", b: "N1" } },
    { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "N1", cathode: "GND" } },
    GROUND
  ];
  const forward = buildIndex(parts);
  const backward = buildIndex([...parts].reverse());
  assert.deepEqual([...forward.nodes.entries()].sort(), [...backward.nodes.entries()].sort());
  assert.equal(forward.size, backward.size);

  const first = solveNetlist(parts);
  const second = solveNetlist([...parts].reverse());
  assert.deepEqual(first.nodes, second.nodes);
});

test("the bill of materials is what you would actually order", () => {
  const lines = billOfMaterials([
    supply(5),
    { id: "R1", kind: "resistor", values: { ohms: 220 }, pins: {} },
    { id: "R2", kind: "resistor", values: { ohms: 220 }, pins: {} },
    { id: "R3", kind: "resistor", values: { ohms: 10_000 }, pins: {} },
    { id: "D1", kind: "led", values: { colour: "red" }, pins: {} },
    GROUND
  ]);
  const resistors = lines.find((line) => line.description === "220Ω resistor");
  assert.equal(resistors.quantity, 2, "two of the same part is one line with a quantity");
  assert.deepEqual(resistors.references, ["R1", "R2"]);
  assert.ok(lines.some((line) => line.description === "10kΩ resistor"));
  assert.equal(lines.some((line) => line.kind === "ground"), false, "a ground symbol is not something you buy");
});

test("values are spoken the way a datasheet writes them", () => {
  assert.equal(formatOhms(4_700), "4.7kΩ");
  assert.equal(formatOhms(1_000_000), "1MΩ");
  assert.equal(formatOhms(220), "220Ω");
  assert.equal(formatFarads(1e-7), "100nF");
  assert.equal(formatAmps(0.0129), "12.9mA");
  // Nobody orders a 3.7k resistor because nobody makes one.
  assert.equal(nearestE12(3_700), 3_900);
  assert.equal(nearestE12(9_500), 10_000);
  assert.equal(nearestE12(220), 220);
});

test("every part in the catalogue can actually be simulated", () => {
  // A part offered in the UI and unknown to the solver is a dead end someone
  // only finds by hitting it.
  for (const kind of PART_KINDS) {
    if (kind === "ground") continue;
    assert.ok(partRatings(kind, {}) !== undefined, `${kind} must answer about its ratings`);
  }
});
