import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runTransient } from "../lib/circuit/transient.mjs";
import { solveNetlist } from "../lib/circuit/netlist.mjs";
import {
  motorValues, motorCompanion, motorSpeed, radiansToRpm, ledBrightness, noteFor, deviceView
} from "../lib/circuit/devices.mjs";
import { CircuitService } from "../lib/circuit.mjs";

// The motor is the claim worth checking hardest.
//
// "A motor spins at a speed proportional to voltage" is the model that is easy
// to write and quietly wrong about the two things motors are famous for. What
// is here instead is a winding, an inductance and a back-EMF, and every figure
// below falls out of those three rather than being written down anywhere.

const GROUND = { id: "GND1", kind: "ground", values: {}, pins: { pin: "GND" } };
const supply = (volts) => ({
  id: "PS1", kind: "supply", values: { volts, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" }
});
const motorAt = (loadTorque = 0) => [
  supply(6),
  { id: "M1", kind: "motor", values: { loadTorque }, pins: { positive: "VCC", negative: "GND" } },
  GROUND
];

test("a stalled motor draws its stall current, which is V over R", () => {
  // The rotor is not turning, so there is no back-EMF and the winding is all
  // that limits the current. This is the figure that melts driver transistors,
  // and a model that reports the running current instead would hide it.
  const result = solveNetlist(motorAt());
  const motor = motorValues({});
  const expected = 6 / (motor.resistance + 0.05);
  assert.ok(Math.abs(result.currents.M1 - expected) < 0.01,
    `expected ${expected.toFixed(3)}A at rest, got ${result.currents.M1}`);
  // And it is well over what the winding will take continuously.
  assert.ok(result.findings.some((finding) => finding.code === "OVER_CURRENT"),
    "a stalled motor is an over-current condition and should say so");
});

test("off load it reaches its no-load speed and draws almost nothing", () => {
  // At speed the back-EMF nearly cancels the supply, so the current collapses.
  // No-load speed is roughly V/Ke.
  const result = runTransient(motorAt(0), {
    seconds: 0.2, dt: 2e-5,
    probes: [{ kind: "speed", target: "M1" }, { kind: "part", target: "M1" }]
  });
  const rpm = result.traces[0].points.at(-1)[1];
  const settled = result.traces[1].points.at(-1)[1];
  const theory = radiansToRpm(6 / motorValues({}).ke);
  assert.ok(Math.abs(rpm - theory) / theory < 0.05, `expected about ${theory.toFixed(0)}rpm, got ${rpm.toFixed(0)}`);
  assert.ok(settled < 0.05, `a free-running motor draws very little, got ${settled}A`);
});

test("it draws a big inrush at start-up and settles", () => {
  // The thing that trips a supply the instant you switch a motor on. It happens
  // here because at t=0 the rotor is still, not because anything says so.
  const result = runTransient(motorAt(0), {
    seconds: 0.2, dt: 2e-5, probes: [{ kind: "part", target: "M1" }]
  });
  const current = result.traces[0].points.map(([, value]) => value);
  const peak = Math.max(...current);
  const settled = current.at(-1);
  assert.ok(peak > 1.5, `expected an inrush near the stall current, got ${peak}A`);
  assert.ok(peak / settled > 20, `inrush should dwarf the running current (${peak}A vs ${settled}A)`);
});

test("loading it slows it down and makes it draw more", () => {
  // Speed falls and current rises, both linearly with torque, which is the
  // whole of a DC motor's character.
  const measured = [0, 0.002, 0.008].map((load) => {
    const result = runTransient(motorAt(load), {
      seconds: 0.2, dt: 2e-5,
      probes: [{ kind: "speed", target: "M1" }, { kind: "part", target: "M1" }]
    });
    return { load, rpm: result.traces[0].points.at(-1)[1], amps: result.traces[1].points.at(-1)[1] };
  });
  for (let index = 1; index < measured.length; index += 1) {
    assert.ok(measured[index].rpm < measured[index - 1].rpm,
      `${measured[index].load}N·m should be slower than ${measured[index - 1].load}`);
    assert.ok(measured[index].amps > measured[index - 1].amps,
      `${measured[index].load}N·m should draw more than ${measured[index - 1].load}`);
  }
  // Torque is Kt·I, so the current at a given load is that load over Kt.
  const expected = 0.008 / motorValues({}).ke;
  assert.ok(Math.abs(measured[2].amps - expected) / expected < 0.15,
    `8mN·m needs about ${expected.toFixed(2)}A, got ${measured[2].amps.toFixed(2)}A`);
});

test("loaded past its stall torque it stops, rather than running backwards", () => {
  // Arithmetically tidy and physically a lie. A stalled motor sits still and
  // cooks; it does not reverse because the sum came out negative.
  const result = runTransient(motorAt(0.05), {
    seconds: 0.1, dt: 2e-5,
    probes: [{ kind: "speed", target: "M1" }, { kind: "part", target: "M1" }]
  });
  const rpm = result.traces[0].points.at(-1)[1];
  assert.ok(rpm >= 0, `a stalled motor must not spin backwards, got ${rpm}rpm`);
  assert.ok(rpm < 1, `and it should not be turning at all, got ${rpm}rpm`);
  assert.ok(result.traces[1].points.at(-1)[1] > 1.5, "while drawing its full stall current");
});

test("a servo goes where the pulse width tells it, and takes time to get there", () => {
  // Pulse width, not duty. A 1ms pulse every 20ms and a 1ms pulse every 5ms mean
  // the same angle and have very different duties.
  const at = (milliseconds) => runTransient([
    supply(5),
    { id: "SIG", kind: "supply", values: { volts: 5, low: 0, waveform: "pulse", frequency: 50, duty: milliseconds / 20, resistance: 10 }, pins: { positive: "SG", negative: "GND" } },
    { id: "M1", kind: "servo", values: {}, pins: { signal: "SG", vcc: "VCC", gnd: "GND" } },
    GROUND
  ], { seconds: 0.4, dt: 2e-5, probes: [{ kind: "angle", target: "M1" }] }).traces[0].points;

  assert.ok(Math.abs(at(1.0).at(-1)[1] - 0) < 3, "1ms is one end");
  assert.ok(Math.abs(at(1.5).at(-1)[1] - 90) < 3, "1.5ms is the middle");
  assert.ok(Math.abs(at(2.0).at(-1)[1] - 180) < 3, "2ms is the other end");

  // It sweeps rather than teleporting, which is what surprises people writing
  // their first servo sweep.
  const journey = at(2.0);
  const quarter = journey[Math.floor(journey.length / 8)][1];
  assert.ok(quarter < 175, `the servo should still be travelling early on, was already at ${quarter}°`);
});

test("a buzzer reports the frequency it is driven at, and names the note", () => {
  const result = runTransient([
    { id: "PS1", kind: "supply", values: { volts: 5, low: 0, waveform: "pulse", frequency: 440, duty: 0.5, resistance: 1 }, pins: { positive: "SG", negative: "GND" } },
    { id: "LS1", kind: "buzzer", values: {}, pins: { a: "SG", b: "GND" } },
    GROUND
  ], { seconds: 0.1, dt: 1e-5, probes: [] });
  const view = deviceView({ id: "LS1", kind: "buzzer" }, result.deviceState, {});
  assert.ok(Math.abs(view.frequency - 440) < 5, `expected 440Hz, got ${view.frequency}`);
  assert.equal(view.note, "A4");
  assert.equal(noteFor(261.63), "C4");
  assert.equal(noteFor(880), "A5");
  assert.equal(noteFor(0), "", "silence has no note");
});

test("brightness follows the eye, not the ammeter", () => {
  // An LED at 2mA looks far more than a tenth as bright as one at 20mA. Drawing
  // it linearly makes every dim LED look dead, which is the opposite of useful
  // when the question is whether a resistor is too big.
  assert.equal(ledBrightness(0), 0);
  assert.equal(Math.round(ledBrightness(0.02) * 100), 100);
  const tenth = ledBrightness(0.002);
  assert.ok(tenth > 0.25, `a tenth of the current should look far more than a tenth as bright, got ${tenth}`);
  assert.ok(tenth < 0.6, "but not almost as bright");
  assert.ok(ledBrightness(0.05) <= 1, "and it cannot exceed full");
});

test("a seven-segment display lights the segments that are driven", () => {
  const result = solveNetlist([
    { id: "PS1", kind: "supply", values: { volts: 5, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 330 }, pins: { a: "VCC", b: "SA" } },
    { id: "R2", kind: "resistor", values: { ohms: 330 }, pins: { a: "VCC", b: "SB" } },
    { id: "DS1", kind: "sevenseg", values: { common: "cathode" }, pins: { a: "SA", b: "SB", common: "GND" } },
    GROUND
  ]);
  assert.equal(result.solved, true);
  // Each driven segment is an ordinary LED and draws an ordinary LED current.
  assert.ok(result.currents.R1 > 0.005 && result.currents.R1 < 0.012, `segment a: ${result.currents.R1 * 1000}mA`);
  assert.ok(Math.abs(result.currents.R1 - result.currents.R2) < 1e-6, "two identical segments draw the same");
  // The package total is what matters against its rating.
  assert.ok(result.currents.DS1 > result.currents.R1, "the package draws the sum of its segments");
});

test("the companion models are the ones the equations give", () => {
  // v = i·R + L·di/dt + Ke·ω, solved for the current at the end of the step.
  const motor = motorValues({});
  const dt = 1e-4;
  const past = { speed: 100, current: 0.5 };
  const { conductance, source, backEmf } = motorCompanion({}, dt, past);
  assert.ok(Math.abs(conductance - (1 / (motor.resistance + (motor.inductance / dt)))) < 1e-12);
  assert.ok(Math.abs(backEmf - (motor.ke * 100)) < 1e-12);
  assert.ok(Math.abs(source - (conductance * (((motor.inductance / dt) * 0.5) - backEmf))) < 1e-12);

  // And a load bigger than the motor can make stalls it rather than reversing.
  assert.equal(motorSpeed({ loadTorque: 1 }, dt, { speed: 0 }, 0), 0);
});

test("a probe can watch a speed or an angle, and only where those exist", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 6, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "motor", pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });

  // Both at once: a motor has a current and a speed, and they are different
  // questions.
  service.apply("probe", { target: "M1", measure: "speed" });
  service.apply("probe", { target: "M1" });
  assert.deepEqual(service.perceive().probes.map((probe) => probe.kind).sort(), ["part", "speed"]);

  assert.throws(() => service.apply("probe", { target: "VCC", measure: "speed" }), (error) => {
    assert.equal(error.code, "CIRCUIT_UNKNOWN_PROBE");
    assert.match(error.message, /a net has no speed/);
    return true;
  });

  // Removing takes every measurement of that part with it.
  service.apply("unprobe", { target: "M1" });
  assert.deepEqual(service.perceive().probes, []);
});

test("the running circuit is described to the page, which computes none of it", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 6, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "motor", loadTorque: 0.004, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("run", { seconds: 0.2, dt: 2e-5 });

  const frame = service.frame();
  const motor = frame.devices.M1;
  assert.ok(motor.rpm > 100, `the motor should be turning, got ${motor.rpm}rpm`);
  assert.ok(motor.turns > 0, "and the shaft angle is a real running total, not an animation");
  assert.equal(motor.stalled, false);
});

test("the warnings describe the same instant as the numbers beside them", () => {
  // A motor's DC operating point is a stalled motor, because at a DC operating
  // point nothing is turning. So while one was happily running at 685mA the
  // schematic carried a warning saying it was passing 1.97A and about to fail —
  // both readings correct, describing different circuits, printed together.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 6, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "motor", pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });

  // At rest it really is over its rating, and should say so.
  assert.ok(service.perceive().findings.some((finding) => finding.code === "OVER_CURRENT"));

  service.apply("run", { seconds: 0.2, dt: 2e-5 });
  const running = service.perceive();
  const motor = running.parts.find((part) => part.id === "M1");
  assert.ok(motor.amps < 0.5, `a free-running motor draws little, got ${motor.amps}A`);
  assert.deepEqual(running.findings, [],
    "so nothing should be warning about a current it is no longer drawing");
});

test("live playback drives the same run path, and stops when the view is left", async () => {
  // Two simulators would disagree, and the one on screen is the one people
  // would believe. The live ticker calls the same endpoint the Run button does.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const live = script.slice(script.indexOf("async function liveTick"), script.indexOf("export function suspendCircuit"));
  assert.match(live, /\/api\/circuit\/run/, "live must go through the ordinary run route");
  assert.doesNotMatch(live, /solveNetlist|stampConductance|Math\.exp/, "and must not simulate anything itself");
  assert.match(script, /export function suspendCircuit/, "leaving the view has to stop it");

  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /suspendCircuit\(\)/, "and app.js has to call that when the view changes");
});
