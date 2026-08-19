import test from "node:test";
import assert from "node:assert/strict";
import { runTransient, suggestTimestep, createHistory, MAX_STEPS_PER_RUN } from "../lib/circuit/transient.mjs";
import { capacitorCompanion, inductorCompanion } from "../lib/circuit/netlist.mjs";
import { sourceVoltage } from "../lib/circuit/parts.mjs";
import { CircuitService } from "../lib/circuit.mjs";

// Same standard as the DC solver: every figure here is one a first-year
// textbook gives in closed form, written in the comment, and asserted against.
// Nothing independently checks these numbers, so they have to be checked
// against the mathematics rather than against whatever the code produced first.

const GROUND = { id: "GND1", kind: "ground", values: {}, pins: { pin: "GND" } };

const rcCircuit = (ohms = 10_000, farads = 1e-5) => ([
  { id: "PS1", kind: "supply", values: { volts: 5, resistance: 0.05, waveform: "dc" }, pins: { positive: "VCC", negative: "GND" } },
  { id: "R1", kind: "resistor", values: { ohms, watts: 0.25 }, pins: { a: "VCC", b: "OUT" } },
  { id: "C1", kind: "capacitor", values: { farads, volts: 50 }, pins: { a: "OUT", b: "GND" } },
  GROUND
]);

test("a capacitor charges on the curve it is supposed to", () => {
  // v(t) = V(1 - e^(-t/RC)). With R=10k and C=10µF, RC = 0.1s.
  // One time constant is 63.2% of the supply, five is 99.3%.
  const at = (multiples) => runTransient(rcCircuit(), {
    seconds: 0.1 * multiples, dt: 0.0002, method: "trapezoidal",
    probes: [{ kind: "net", target: "OUT" }]
  }).traces[0].points.at(-1)[1];

  const one = at(1);
  const five = at(5);
  assert.ok(Math.abs(one - (5 * (1 - Math.exp(-1)))) < 0.01, `at 1τ expected 3.16V, got ${one}`);
  assert.ok(Math.abs(five - (5 * (1 - Math.exp(-5)))) < 0.01, `at 5τ expected 4.97V, got ${five}`);
  assert.ok(one / 5 > 0.62 && one / 5 < 0.64, "which is the 63.2% everyone remembers");
});

test("trapezoidal is more accurate than Euler, and the first step is why", () => {
  // Trapezoidal error falls with the square of the step, Euler's only linearly,
  // so halving dt should improve trapezoidal about four times as much.
  //
  // It did not, at first, and the reason is the whole point of this test.
  // Trapezoidal needs the current each part carried at the end of the previous
  // step, and at t=0 there is none — the history says zero when a capacitor
  // across a resistor is passing V/R the instant the supply appears. Seeded
  // with that wrong figure it carried the error the whole way and measured no
  // better than Euler. The first step is now always Euler, as SPICE does.
  const exact = 5 * (1 - Math.exp(-1));
  const error = (method, dt) => {
    const value = runTransient(rcCircuit(), {
      seconds: 0.1, dt, method, probes: [{ kind: "net", target: "OUT" }]
    }).traces[0].points.at(-1)[1];
    return Math.abs(value - exact);
  };

  const coarse = error("trapezoidal", 0.001);
  const fine = error("trapezoidal", 0.0005);
  assert.ok(coarse < error("euler", 0.001) / 10,
    `trapezoidal should be far better than Euler at the same step (${coarse} vs ${error("euler", 0.001)})`);
  assert.ok(fine < coarse / 2, `halving the step should improve trapezoidal sharply (${coarse} → ${fine})`);
});

test("an inductor's current rises on its own curve", () => {
  // i(t) = (V/R)(1 - e^(-tR/L)). R=1k, L=100mH, so L/R = 100µs and the final
  // current is 5mA. One time constant is 63.2% of that: 3.16mA.
  const result = runTransient([
    { id: "PS1", kind: "supply", values: { volts: 5, resistance: 0.001 }, pins: { positive: "VCC", negative: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "VCC", b: "M" } },
    { id: "L1", kind: "inductor", values: { henries: 0.1 }, pins: { a: "M", b: "GND" } },
    GROUND
  ], { seconds: 1e-4, dt: 1e-6, probes: [{ kind: "part", target: "L1" }] });

  const current = result.traces[0].points.at(-1)[1];
  const expected = 5e-3 * (1 - Math.exp(-1));
  assert.ok(Math.abs(current - expected) < 5e-5, `at 1τ expected 3.16mA, got ${current * 1000}mA`);
});

test("an RC low-pass attenuates by the amount the formula says", () => {
  // Gain = 1 / sqrt(1 + (2πfRC)²). R=1k, C=1µF gives a corner at 159Hz, so a
  // 1kHz sine comes through at about 0.157 of its amplitude.
  const result = runTransient([
    { id: "PS1", kind: "supply", values: { volts: 0, resistance: 0.001, waveform: "sine", amplitude: 5, frequency: 1_000 }, pins: { positive: "IN", negative: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "IN", b: "OUT" } },
    { id: "C1", kind: "capacitor", values: { farads: 1e-6, volts: 50 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ], { seconds: 0.01, probes: [{ kind: "net", target: "IN" }, { kind: "net", target: "OUT" }] });

  // The second half only, so the initial charge-up is not mistaken for signal.
  const peak = (trace) => Math.max(...trace.points.slice(Math.floor(trace.points.length / 2)).map(([, value]) => Math.abs(value)));
  const gain = peak(result.traces[1]) / peak(result.traces[0]);
  const theory = 1 / Math.sqrt(1 + ((2 * Math.PI * 1_000 * 1_000 * 1e-6) ** 2));
  assert.ok(Math.abs(gain - theory) < 0.02, `expected about ${theory.toFixed(3)}, got ${gain.toFixed(3)}`);
});

test("a recorded point is labelled with the instant it describes", () => {
  // It was labelled one step later. Backward Euler is backward precisely
  // because it evaluates at the end of the step; stamping the source at the
  // start and then timestamping the answer with the end drove the circuit with
  // a stale value *and* misdated every point. On a 200Hz sine at 50µs steps
  // that is a visible phase error, and it would have been read as something the
  // circuit was doing rather than something the solver was.
  const wave = { volts: 0, waveform: "sine", amplitude: 5, frequency: 200 };
  const result = runTransient([
    { id: "PS1", kind: "supply", values: { ...wave, resistance: 0.01 }, pins: { positive: "IN", negative: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "IN", b: "OUT" } },
    { id: "C1", kind: "capacitor", values: { farads: 1e-6 }, pins: { a: "OUT", b: "GND" } },
    GROUND
  ], { seconds: 0.0125, dt: 5e-5, probes: [{ kind: "net", target: "IN" }] });

  // The source has 0.01Ω of internal resistance, so IN sits a rounding error
  // below the open-circuit value rather than exactly on it.
  for (const [time, value] of result.traces[0].points.slice(-5)) {
    const expected = sourceVoltage(wave, time);
    assert.ok(Math.abs(value - expected) < 0.01,
      `at t=${time} the trace says ${value} and the source is at ${expected}`);
  }
});

test("a sine and a pulse put out what they say they do", () => {
  const sine = { volts: 0, waveform: "sine", amplitude: 5, frequency: 1_000 };
  assert.ok(Math.abs(sourceVoltage(sine, 0)) < 1e-9, "a sine starts at zero");
  assert.ok(Math.abs(sourceVoltage(sine, 0.00025) - 5) < 1e-9, "and peaks a quarter period later");
  assert.ok(Math.abs(sourceVoltage(sine, 0.00075) + 5) < 1e-9, "and troughs at three quarters");

  const pulse = { volts: 5, waveform: "pulse", frequency: 1_000, duty: 0.25, low: 0 };
  assert.equal(sourceVoltage(pulse, 0), 5);
  assert.equal(sourceVoltage(pulse, 0.0002), 5, "high for the first quarter");
  assert.equal(sourceVoltage(pulse, 0.0003), 0, "low for the rest");
  assert.equal(sourceVoltage(pulse, 0.0011), 5, "and it repeats");
});

test("capacitors start uncharged, which is what someone pressing Run wants to see", () => {
  // SPICE defaults to starting at the DC operating point, where an RC across a
  // supply begins fully charged and the run is a flat line. Defensible, and
  // useless for watching something charge.
  const result = runTransient(rcCircuit(), {
    seconds: 0.5, dt: 0.001, probes: [{ kind: "net", target: "OUT" }]
  });
  const first = result.traces[0].points[0][1];
  const last = result.traces[0].points.at(-1)[1];
  assert.ok(first < 0.2, `the run should start near zero, got ${first}`);
  assert.ok(last > 4.9, "and end near the supply");
});

test("a timestep is chosen from the fastest thing in the circuit", () => {
  // Nobody should have to know what a time constant is before they can watch a
  // capacitor charge.
  const fast = suggestTimestep(rcCircuit(1_000, 1e-9), 0.001);
  const slow = suggestTimestep(rcCircuit(100_000, 1e-4), 10);
  assert.ok(fast < slow, "a faster circuit gets a finer step");
  assert.ok(suggestTimestep(rcCircuit(), 0.5) <= 0.5 / 50, "and never fewer than fifty steps across the run");
});

test("an impossible run is refused with the number that makes it impossible", () => {
  assert.throws(() => runTransient(rcCircuit(), { seconds: 1, dt: 1e-9 }), (error) => {
    assert.equal(error.code, "CIRCUIT_RUN_TOO_LONG");
    assert.match(error.message, /steps/);
    assert.match(error.message, /Run for less time, or set a larger dt/, "a refusal has to say what would work");
    return true;
  });
  assert.throws(() => runTransient(rcCircuit(), { seconds: 0 }), (error) => {
    assert.equal(error.code, "CIRCUIT_TRANSIENT_INVALID");
    return true;
  });
  assert.throws(() => runTransient(rcCircuit(), { seconds: 1, method: "runge-kutta" }), (error) => {
    assert.equal(error.code, "CIRCUIT_TRANSIENT_INVALID");
    return true;
  });
});

test("a broken circuit is not run and says why", () => {
  const result = runTransient([
    { id: "PS1", kind: "supply", values: { volts: 5 }, pins: { positive: "A", negative: "B" } },
    { id: "R1", kind: "resistor", values: { ohms: 1_000 }, pins: { a: "A", b: "B" } }
  ], { seconds: 0.1 });
  assert.equal(result.ran, false);
  assert.ok(result.findings.some((finding) => finding.code === "NO_GROUND"));
  assert.deepEqual(result.traces, []);
});

test("the companion models are the textbook ones", () => {
  // Backward Euler for a capacitor: i = (C/h)(v - v_prev), so the conductance is
  // C/h and the source carries -(C/h)v_prev.
  const past = { voltage: 2, current: 0.001 };
  const euler = capacitorCompanion(1e-6, 1e-3, past, "euler");
  assert.ok(Math.abs(euler.conductance - 1e-3) < 1e-15);
  assert.ok(Math.abs(euler.source - (-2e-3)) < 1e-15);

  // Trapezoidal: i = (2C/h)(v - v_prev) - i_prev.
  const trap = capacitorCompanion(1e-6, 1e-3, past, "trapezoidal");
  assert.ok(Math.abs(trap.conductance - 2e-3) < 1e-15);
  assert.ok(Math.abs(trap.source - (-((2e-3 * 2) + 0.001))) < 1e-15);

  // An inductor is the dual: conductance h/L, carrying the current it had.
  const coil = inductorCompanion(0.1, 1e-3, past, "euler");
  assert.ok(Math.abs(coil.conductance - 0.01) < 1e-15);
  assert.ok(Math.abs(coil.source - 0.001) < 1e-15);
});

test("a run continues where the last one stopped", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 10_000, pins: { a: "VCC", b: "OUT" } });
  service.apply("add", { kind: "capacitor", farads: 1e-5, pins: { a: "OUT", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("probe", { target: "OUT" });

  const first = service.apply("run", { seconds: 0.1 });
  const second = service.apply("run", { seconds: 0.1 });
  assert.ok(Math.abs(second.time - 0.2) < 1e-9, "time accumulates");
  assert.ok(second.nets.OUT > first.nets.OUT, "and the capacitor keeps charging");
  assert.ok(second.traces[0].points.length > first.traces[0].points.length, "the trace grows rather than restarting");
  // And the first result did not grow along with it. The traces were being
  // extended in place, so a reading already handed to a caller gained a hundred
  // points the next time anything ran — a returned figure that changes
  // underneath whoever is holding it, with nothing about it looking wrong.
  assert.equal(first.traces[0].points.length, 50, "an earlier reading must not change underneath its holder");

  // Rewind puts it back without touching what was built.
  service.apply("rewind", {});
  assert.equal(service.perceive().elapsedSeconds, 0);
  assert.equal(service.perceive().counts.parts, 4);
});

test("changing the circuit throws away the run that described the old one", () => {
  // A plot labelled with a resistor that is no longer in the circuit is a claim
  // about something that never happened, and it is exactly the kind of thing
  // someone reads without checking.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 10_000, pins: { a: "VCC", b: "OUT" } });
  service.apply("add", { kind: "capacitor", farads: 1e-5, pins: { a: "OUT", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("probe", { target: "OUT" });
  service.apply("run", { seconds: 0.1 });
  assert.ok(service.frame().traces[0].points.length > 0);

  service.apply("adjust", { id: "R1", values: { ohms: 1_000 } });
  assert.equal(service.perceive().elapsedSeconds, 0);
  assert.deepEqual(service.frame().traces, []);
  // The probe survives, because it is part of what you are studying rather than
  // part of the run.
  assert.deepEqual(service.perceive().probes.map((probe) => probe.target), ["OUT"]);
});

test("probes are saved with the circuit and traces are not", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "VCC", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("probe", { target: "R1" });
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.probes, [{ kind: "part", target: "R1" }]);
  assert.equal("traces" in snapshot, false, "a trace is the result of an experiment, not part of the circuit");

  const reopened = new CircuitService();
  reopened.restore(snapshot);
  assert.deepEqual(reopened.perceive().probes.map((probe) => probe.target), ["R1"]);
  assert.equal(reopened.perceive().elapsedSeconds, 0, "and it reopens not yet run");
});

test("a probe names a net or a part, and Evolv works out which", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "VCC", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  assert.equal(service.apply("probe", { target: "VCC" }).probes.at(-1).kind, "net");
  assert.equal(service.apply("probe", { target: "R1" }).probes.at(-1).kind, "part");
  assert.throws(() => service.apply("probe", { target: "NOPE" }), (error) => {
    assert.equal(error.code, "CIRCUIT_UNKNOWN_PROBE");
    return true;
  });
});

test("after a run the schematic shows the instant, not the settled state", () => {
  // The drawing said "IN 0V" while the traces directly beneath it swung between
  // ±5V and the clock read t = 20ms. Both were technically correct — the
  // operating point of a circuit driven by a sine really is zero on average —
  // and together they were a lie, because only the drawing looks authoritative.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 0, waveform: "sine", amplitude: 5, frequency: 200, resistance: 0.01, pins: { positive: "IN", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "IN", b: "OUT" } });
  service.apply("add", { kind: "capacitor", farads: 1e-6, pins: { a: "OUT", b: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });

  const before = service.perceive();
  assert.equal(before.reading, "steady");
  assert.equal(before.nets.IN, 0, "before a run there is no instant to report");

  // Three quarters of the way through a cycle, where the output is well away
  // from zero.
  service.apply("run", { seconds: 0.0125, method: "trapezoidal" });
  const during = service.perceive();
  assert.equal(during.reading, "instant", "and the interface has to say which claim it is making");
  assert.ok(Math.abs(during.nets.OUT) > 1, `the schematic should show a real voltage, got ${during.nets.OUT}`);
  assert.ok(during.parts.find((part) => part.id === "R1").amps !== 0, "and a real current");

  service.apply("rewind", {});
  assert.equal(service.perceive().reading, "steady");
});

test("a long run is thinned rather than returned whole", () => {
  // Every trace point is sent to the browser, so twenty thousand steps would be
  // megabytes of JSON nobody plots.
  const result = runTransient(rcCircuit(), {
    seconds: 1, dt: 0.00005, probes: [{ kind: "net", target: "OUT" }]
  });
  assert.equal(result.steps, 20_000);
  assert.ok(result.traces[0].points.length <= 1_001, `expected thinning, got ${result.traces[0].points.length} points`);
  assert.ok(result.traces[0].points.length > 500, "but enough of them to draw a curve");
  assert.ok(result.steps <= MAX_STEPS_PER_RUN);
});
