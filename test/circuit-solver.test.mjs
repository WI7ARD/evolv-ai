import test from "node:test";
import assert from "node:assert/strict";
import { MnaSystem, solveNonlinear, diodeCompanion, THERMAL_VOLTAGE } from "../lib/circuit/solver.mjs";

// The load-bearing test file.
//
// Every other part of the circuit sandbox rests on these numbers being right,
// and there is no second implementation to check them against — SPICE netlist
// export was deliberately left out, so nothing else can independently confirm
// the solver. So every circuit here has an answer worked out by hand from Ohm's
// law and Kirchhoff's, written in the comment, and the test asserts that number
// rather than whatever the code happened to produce first.
//
// Node numbering: -1 is ground and gets no row. Unknowns are 0..n-1 for node
// voltages, then one more for each voltage source's current.

const NEAR = 1e-9;

// A helper matching how the real netlist will drive this: stamp, solve, read.
function dc(size, stamp) {
  const { solution } = solveNonlinear(size, (system) => stamp(system));
  return solution;
}

test("a resistive divider splits voltage in proportion to resistance", () => {
  // 9V ── R1 10k ── N1 ── R2 5k ── ground
  // N1 = 9 × 5k/(10k+5k) = 3V exactly. Current = 9/15k = 0.6mA.
  // Unknowns: 0 = N0 (source top), 1 = N1, 2 = source current.
  const solution = dc(3, (system) => {
    system.stampVoltageSource(0, -1, 2, 9);
    system.stampConductance(0, 1, 1 / 10_000);
    system.stampConductance(1, -1, 1 / 5_000);
  });
  assert.ok(Math.abs(solution[0] - 9) < NEAR, `source node should be 9V, got ${solution[0]}`);
  assert.ok(Math.abs(solution[1] - 3) < NEAR, `divider should give exactly 3V, got ${solution[1]}`);
  // The source's current is negative by MNA's sign convention: current flows out
  // of its positive terminal, into the circuit.
  assert.ok(Math.abs(Math.abs(solution[2]) - 0.0006) < 1e-12, `expected 0.6mA, got ${Math.abs(solution[2])}`);
});

test("resistors in parallel carry current in inverse proportion", () => {
  // 12V across 4k ∥ 12k. Combined = 3k, total current 4mA.
  // Unknowns: 0 = top node, 1 = source current.
  const solution = dc(2, (system) => {
    system.stampVoltageSource(0, -1, 1, 12);
    system.stampConductance(0, -1, 1 / 4_000);
    system.stampConductance(0, -1, 1 / 12_000);
  });
  assert.ok(Math.abs(solution[0] - 12) < NEAR);
  assert.ok(Math.abs(Math.abs(solution[1]) - 0.004) < 1e-12, `12V / 3k = 4mA, got ${Math.abs(solution[1])}`);
});

test("a current source into a resistor obeys Ohm's law", () => {
  // 2mA into 2.2k to ground. V = 0.002 × 2200 = 4.4V.
  const solution = dc(1, (system) => {
    system.stampCurrent(-1, 0, 0.002);
    system.stampConductance(0, -1, 1 / 2_200);
  });
  assert.ok(Math.abs(solution[0] - 4.4) < 1e-9, `expected 4.4V, got ${solution[0]}`);
});

test("a ladder of equal resistors needs pivoting to come out right", () => {
  // Five 1k resistors in series across 10V. Each node steps down by 2V exactly.
  // This is the case that fails without partial pivoting: the rows are near
  // enough alike that a naive elimination divides by something tiny and returns
  // numbers that look plausible and are wrong.
  const solution = dc(6, (system) => {
    system.stampVoltageSource(0, -1, 5, 10);
    for (let index = 0; index < 4; index += 1) system.stampConductance(index, index + 1, 1 / 1_000);
    system.stampConductance(4, -1, 1 / 1_000);
  });
  for (let index = 0; index <= 4; index += 1) {
    const expected = 10 - (index * 2);
    assert.ok(Math.abs(solution[index] - expected) < 1e-9, `node ${index} should be ${expected}V, got ${solution[index]}`);
  }
});

test("a Thevenin equivalent behaves like the network it replaces", () => {
  // 10V behind 3k, loaded with 6k. Vout = 10 × 6/(3+6) = 6.666…V
  const solution = dc(3, (system) => {
    system.stampVoltageSource(0, -1, 2, 10);
    system.stampConductance(0, 1, 1 / 3_000);
    system.stampConductance(1, -1, 1 / 6_000);
  });
  assert.ok(Math.abs(solution[1] - (20 / 3)) < 1e-9, `expected 6.667V, got ${solution[1]}`);
});

test("a diode drops roughly its forward voltage and blocks the other way", () => {
  // 5V through 1k into a diode to ground. A silicon diode passing ~4.3mA sits
  // near 0.6-0.75V; the exact figure comes from the exponential, so this asserts
  // the band a real part would show rather than a fabricated decimal.
  const forward = solveNonlinear(3, (system, solution, circuit) => {
    system.stampVoltageSource(0, -1, 2, 5);
    system.stampConductance(0, 1, 1 / 1_000);
    circuit.diode("d1", 1, -1);
  });
  const drop = forward.solution[1];
  assert.ok(drop > 0.55 && drop < 0.8, `a conducting silicon diode should sit near 0.7V, got ${drop}`);

  // Reversed, it should pass almost nothing, so nearly all 5V stands across it.
  const reverse = solveNonlinear(3, (system, solution, circuit) => {
    system.stampVoltageSource(0, -1, 2, 5);
    system.stampConductance(0, 1, 1 / 1_000);
    // Cathode at the node, anode at ground: the diode faces the other way.
    circuit.diode("d1", -1, 1);
  });
  assert.ok(reverse.solution[1] > 4.99, `a reverse-biased diode should block, node sat at ${reverse.solution[1]}`);
});

test("a caller cannot accidentally disable the limiting", () => {
  // The first version of this solver made the limiting the caller's job, and
  // the first caller passed the current guess as the previous value — so
  // nothing was ever limited and every diode circuit reported that it would not
  // settle. The context helper owns the memory now, so there is nothing to get
  // wrong; this pins that it is doing it.
  let limitedSteps = [];
  solveNonlinear(3, (system, solution, circuit) => {
    system.stampVoltageSource(0, -1, 2, 5);
    system.stampConductance(0, 1, 1 / 1_000);
    limitedSteps.push(circuit.diode("d1", 1, -1).voltage);
  });
  const jumps = limitedSteps.slice(1).map((value, index) => Math.abs(value - limitedSteps[index]));
  assert.ok(jumps.every((jump) => jump <= 0.5 + 1e-12), `no step may exceed half a volt, saw ${Math.max(...jumps)}`);
  assert.ok(limitedSteps.length > 2, "and it should take more than one step to walk there");
});

test("the exponential is limited so Newton cannot overflow", () => {
  // Unlimited, a 40V guess gives exp(40/0.026) = Infinity and every later number
  // is NaN. This is the single most common way a hand-written solver dies.
  const wild = diodeCompanion(40, { previous: 0 });
  assert.ok(Number.isFinite(wild.conductance), "conductance must stay finite");
  assert.ok(Number.isFinite(wild.current), "current must stay finite");
  assert.ok(wild.voltage <= 0.5 + 1e-12, "the step is limited to half a volt at a time");

  // And deep reverse bias must not underflow into a divide by zero.
  const blocked = diodeCompanion(-30, { previous: -30 });
  assert.ok(Number.isFinite(blocked.conductance) && blocked.conductance > 0);
  assert.ok(Math.abs(blocked.current) < 1e-12, "a blocked diode passes only leakage");
});

test("a part that needs several steps to switch on is not declared settled early", () => {
  // The bug this pins returned "5.000V, 0.00mA" for a lit LED, and no test
  // caught it, because a plain silicon diode reaches its knee inside two
  // limited steps and never shows the problem.
  //
  // An LED starts around 2V. From a cold start of zero that is four or five
  // half-volt steps, and through every one of them the part is still
  // effectively open, so the node voltages do not move at all. Judging
  // convergence on the solution alone declares victory on the second iteration.
  // A junction that had to be limited means the search is still walking.
  const red = { saturationCurrent: 1e-20, emission: 2 };
  const lit = solveNonlinear(3, (system, solution, circuit) => {
    system.stampVoltageSource(0, -1, 2, 5);
    system.stampConductance(0, 1, 1 / 220);
    circuit.diode("led", 1, -1, red);
  });
  const across = lit.solution[1];
  const milliamps = ((5 - across) / 220) * 1000;
  // A red LED on 5V through 220R: about 2.1V and 13mA. Measurable on a bench,
  // and nothing like the 5V and zero current the premature check reported.
  assert.ok(across > 1.8 && across < 2.4, `a red LED should sit near 2.1V, got ${across}`);
  assert.ok(milliamps > 10 && milliamps < 16, `expected about 13mA, got ${milliamps}`);
  assert.ok(lit.iterations > 4, "and it must take more than the two iterations the old check stopped at");
});

test("a circuit with no reference is refused rather than answered", () => {
  // Two nodes joined by a resistor and nothing else: the voltages could be
  // anything as long as their difference is right. Infinitely many answers is
  // not an answer, and returning one of them would be worse than failing.
  assert.throws(() => dc(2, (system) => {
    system.stampConductance(0, 1, 1 / 1_000);
  }), (error) => {
    assert.equal(error.code, "CIRCUIT_SINGULAR");
    assert.match(error.message, /connected to nothing|shorted/);
    return true;
  });
});

test("an empty circuit says so instead of dividing by nothing", () => {
  assert.throws(() => dc(0, () => {}), (error) => {
    assert.equal(error.code, "CIRCUIT_EMPTY");
    return true;
  });
});

test("the same circuit solved twice gives identical numbers", () => {
  // Determinism is what makes snapshots and tests stable. Floating point is
  // deterministic; iteration order and object enumeration are what usually are
  // not, so this guards the code around the arithmetic rather than the
  // arithmetic itself.
  const build = (system, solution, circuit) => {
    system.stampVoltageSource(0, -1, 2, 5);
    system.stampConductance(0, 1, 1 / 1_000);
    circuit.diode("d1", 1, -1);
  };
  const first = solveNonlinear(3, build);
  const second = solveNonlinear(3, build);
  assert.deepEqual([...first.solution], [...second.solution]);
  assert.equal(first.iterations, second.iterations);
});

test("thermal voltage is the real one", () => {
  // kT/q at 300K. Every diode number above depends on it, so a typo here would
  // shift them all by a plausible-looking amount.
  assert.ok(Math.abs(THERMAL_VOLTAGE - 0.02585) < 0.0001);
});
