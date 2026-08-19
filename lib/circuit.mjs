// The circuit sandbox: a schematic Evolv can build in and look at.
//
// Shaped deliberately like lib/physics.mjs, because the reasoning that produced
// that shape still holds. The simulation runs here, in the server, not in the
// browser: perception has to be honest, so "what is in this circuit" means what
// the solver just computed rather than what some tab currently believes, and it
// answers the same whether or not a window is open. The renderer draws symbols
// and computes nothing.
//
// Every change goes through apply(). A model calling circuit_build and a person
// clicking the toolbar reach the same code, which is the only way the two can be
// guaranteed to agree about what a part is.

import { PARTS, PART_KINDS, nearestE12 } from "./circuit/parts.mjs";
import { solveNetlist, billOfMaterials, netlistError, MAX_COMPONENTS, MAX_NETS, resolveNets } from "./circuit/netlist.mjs";
import { layout } from "./circuit/layout.mjs";
import { runTransient, createHistory, METHODS, MAX_STEPS_PER_RUN, transientError } from "./circuit/transient.mjs";
import { createChipState } from "./circuit/chips.mjs";
import { createDeviceState, deviceView } from "./circuit/devices.mjs";
import { createMcus } from "./circuit/mcu.mjs";
import { parse as parseFirmware, FirmwareError } from "./circuit/firmware.mjs";
import {
  normaliseExpectation, checkExpectation, describeExpectation, probeKindFor, secondsNeededFor, summarise
} from "./circuit/expectations.mjs";
import { createConditions, normaliseCondition, conditionsAt, describeConditions, QUANTITIES } from "./circuit/conditions.mjs";
import { sensorView, SENSOR_KINDS } from "./circuit/sensors.mjs";

// Bumped when the meaning of a saved circuit changes. A circuit claiming a
// higher number is refused rather than half-understood — the same rule
// lib/physics.mjs applies to scenes, for the same reason: a partial restore
// looks like a corrupted save rather than an incompatible one.
export const CIRCUIT_VERSION = 1;

// Reference designators, as printed on a real board. R1, C3, D2 — this is the
// vocabulary of every schematic and every parts list, and inventing something
// else would make the bill of materials useless for actually building.
const DESIGNATORS = Object.freeze({
  resistor: "R", capacitor: "C", inductor: "L", diode: "D", led: "D",
  switch: "SW", potentiometer: "RV", battery: "BT", supply: "PS", ground: "GND",
  // Integrated circuits are all U on a real board, numbered in one sequence, so
  // an op-amp and a 555 in the same circuit are U1 and U2. A header is J.
  opamp: "U", regulator: "U", gate: "U", flipflop: "U", timer555: "U", mcupin: "J",
  // A servo is a motor, so it shares the motor sequence rather than starting a
  // parallel one. LS is the standard designator for a sounder, DS for a display.
  motor: "M", servo: "M", buzzer: "LS", rgbled: "D", sevenseg: "DS", mcu: "U",
  // RT is the standard designator for a thermistor. A photoresistor is just an
  // R on a real board and shares the resistor sequence, which is not an
  // oversight — it is what a schematic does, and a bill of materials that
  // invented LDR1 would not match the board it came from. The two sensors that
  // are chips are U, like every other chip.
  thermistor: "RT", ldr: "R", hall: "U", accelerometer: "U"
});

const NET_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]{0,23}$/;

function fail(message, code = "CIRCUIT_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

export class CircuitService {
  #components = new Map();
  #counters = new Map();
  #cache = null;
  // Where the run has got to, what each energy-storing part is holding, and
  // what the probes recorded. Deliberately not part of the circuit: a snapshot
  // saves what was built, not what happened when it was last run.
  #time = 0;
  #history = null;
  #chipState = null;
  #deviceState = null;
  // Firmware, kept per microcontroller and saved with the circuit. It is part of
  // what was built, not part of what happened when it was last run.
  #firmware = new Map();
  // What the finished thing is supposed to do. Part of the circuit, unlike the
  // traces: a snapshot that reopened without its expectations would be a design
  // that had forgotten its own requirements.
  #expectations = new Map();
  // The surroundings the circuit is in. Part of the circuit for the same reason
  // the expectations are: a board reopened at a temperature it was never
  // designed for would be a different experiment wearing the same name.
  #conditions = createConditions();
  #mcus = null;
  #probes = new Map();
  #traces = [];
  // The readings at the instant the run stopped. Without these the schematic
  // keeps showing the DC operating point while the clock says t = 20ms and the
  // traces beside it swing between ±5V — the drawing and the plot describing
  // different moments, with only the drawing looking authoritative.
  #atTime = null;

  // Adding a part.
  //
  // Values are filled from the part's defaults rather than left undefined, so a
  // model that says "add a resistor" gets a real 1kΩ quarter-watt part instead
  // of one with no resistance, and the circuit solves rather than reporting
  // something confusing about a division.
  add({ kind, id = "", pins = {}, ...values }) {
    if (!PART_KINDS.includes(kind)) throw fail(`There is no such part as a ${kind}. Available: ${PART_KINDS.join(", ")}.`, "CIRCUIT_UNKNOWN_PART");
    if (this.#components.size >= MAX_COMPONENTS) {
      throw fail(`A circuit here holds at most ${MAX_COMPONENTS} parts.`, "CIRCUIT_TOO_LARGE");
    }
    const definition = PARTS[kind];
    const reference = id || this.#nextId(kind);
    if (this.#components.has(reference)) throw fail(`There is already a part called ${reference}.`, "CIRCUIT_DUPLICATE_ID");

    const resolved = { ...definition.defaults, ...cleanValues(kind, values) };
    // A resistance nobody sells is a resistance nobody can buy. Snapping is
    // silent but reported back, so the model sees what it actually got.
    let snapped = null;
    if (kind === "resistor" || kind === "potentiometer") {
      const nearest = nearestE12(resolved.ohms);
      if (nearest !== null && nearest !== resolved.ohms) {
        snapped = { asked: resolved.ohms, given: nearest };
        resolved.ohms = nearest;
      }
    }

    const wired = {};
    for (const pin of definition.pins) {
      const net = pins[pin];
      if (net === undefined || net === null || net === "") continue;
      wired[pin] = validNet(net);
    }
    this.#components.set(reference, { id: reference, kind, values: resolved, pins: wired });
    this.#changed();
    return { id: reference, kind, values: resolved, pins: wired, ...(snapped ? { snapped } : {}) };
  }

  // Joining a pin to a net. This is what a wire is.
  wire(id, pin, net) {
    const component = this.#require(id);
    const definition = PARTS[component.kind];
    if (!definition.pins.includes(pin)) {
      throw fail(`A ${component.kind} has no pin called ${pin}. Its pins are: ${definition.pins.join(", ")}.`, "CIRCUIT_UNKNOWN_PIN");
    }
    const next = { ...component.pins };
    if (net === "" || net === null) delete next[pin];
    else next[pin] = validNet(net);
    if (new Set(Object.keys(this.#nets({ ...Object.fromEntries(this.#components), [id]: { ...component, pins: next } }))).size > MAX_NETS) {
      throw fail(`A circuit here holds at most ${MAX_NETS} nets.`, "CIRCUIT_TOO_LARGE");
    }
    this.#components.set(id, { ...component, pins: next });
    this.#changed();
    return { id, pins: next };
  }

  adjust(id, values) {
    const component = this.#require(id);
    const next = { ...component.values, ...cleanValues(component.kind, values) };
    this.#components.set(id, { ...component, values: next });
    this.#changed();
    return { id, values: next };
  }

  remove(id) {
    this.#require(id);
    this.#components.delete(id);
    this.#probes.delete(id);
    this.#changed();
    return { removed: id };
  }

  clear() {
    this.#components.clear();
    this.#counters.clear();
    this.#probes.clear();
    this.#expectations.clear();
    this.#conditions = createConditions();
    this.#changed();
    return this.perceive();
  }

  // Any change to the circuit ends the run that was describing the old one.
  //
  // Keeping the traces would be worse than losing them: a plot labelled with a
  // resistor that is no longer in the circuit is a claim about something that
  // never happened, and it is exactly the kind of thing someone reads without
  // checking.
  #changed() {
    this.#cache = null;
    this.#time = 0;
    this.#history = null;
    this.#chipState = null;
    this.#deviceState = null;
    this.#mcus = null;
    this.#traces = [];
    this.#atTime = null;
  }

  // Give a microcontroller its firmware.
  //
  // Parsed here rather than at the first run, so a syntax error is reported
  // where it was written rather than surfacing later as a chip that mysteriously
  // does nothing.
  writeFirmware(id, source) {
    const component = this.#require(id);
    if (component.kind !== "mcu") throw fail(`${id} is a ${component.kind}, not a microcontroller.`, "CIRCUIT_NOT_MCU");
    const text = String(source ?? "");
    if (text.length > 40_000) throw fail("That firmware is too long for this sandbox.", "FIRMWARE_TOO_LONG");
    try {
      parseFirmware(text);
    } catch (error) {
      // The line number is the useful part, so it survives.
      throw error instanceof FirmwareError ? error : fail(String(error.message || error), "FIRMWARE_INVALID");
    }
    this.#firmware.set(id, text);
    this.#changed();
    return { id, lines: text.split("\n").length };
  }

  readFirmware(id) {
    this.#require(id);
    return { id, source: this.#firmware.get(id) || "" };
  }

  // Watch a net's voltage or a part's current over time.
  //
  // A name is looked up rather than declared: a model that says "probe OUT"
  // means the net, and one that says "probe R1" means the current through it,
  // and asking it to say which is asking it to get something right that can
  // simply be worked out.
  probe(target, measure = "") {
    const name = String(target || "").trim();
    if (!name) throw fail("Say what to probe: a net name such as OUT, or a part such as R1.");
    const isPart = this.#components.has(name);
    // A motor has a speed as well as a current, and a servo an angle. Naming
    // what to measure is optional because for almost everything there is only
    // one answer — a net has a voltage and a resistor has a current.
    let kind = isPart ? "part" : "net";
    if (measure === "speed" || measure === "angle") {
      if (!isPart) throw fail(`${name} is a net, and a net has no ${measure}.`, "CIRCUIT_UNKNOWN_PROBE");
      kind = measure;
    }
    if (kind === "net" && !Object.keys(this.#netMap()).includes(name)) {
      throw fail(`There is no net or part called ${name} in this circuit.`, "CIRCUIT_UNKNOWN_PROBE");
    }
    this.#probes.set(`${name}:${kind}`, { kind, target: name });
    this.#cache = null;
    return { probes: [...this.#probes.values()] };
  }

  // Set what the world is doing, for the sensors to respond to.
  //
  // Either a number or a ramp — `{ from, to, seconds }` — because the question
  // these exist to answer is "does my board read the right speed while I
  // accelerate", and a constant cannot ask it.
  setConditions(input = {}) {
    const asked = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const entries = Object.entries(asked).filter(([name]) => name in QUANTITIES);
    if (!entries.length) {
      throw fail(`Say what to change. Evolv knows about: ${Object.keys(QUANTITIES).join(", ")}.`, "CIRCUIT_CONDITION_INVALID");
    }
    for (const [name, setting] of entries) this.#conditions.set(name, normaliseCondition(name, setting));
    // Changing the world invalidates a run the same way changing a part does —
    // the traces on screen were recorded somewhere else.
    this.#changed();
    return { conditions: this.readConditions() };
  }

  readConditions() {
    return {
      settings: Object.fromEntries([...this.#conditions]),
      now: conditionsAt(this.#conditions, this.#time),
      description: describeConditions(this.#conditions)
    };
  }

  // State something the circuit is supposed to do.
  //
  // Stored rather than checked here, because an expectation is a property of
  // the design and the check is an experiment. Writing one down before the
  // circuit works is the normal order of events, and being told "failed" at the
  // moment you write it would make that order feel like an error.
  expect(input = {}) {
    const subjects = [...Object.keys(this.#netMap()), ...this.#components.keys()];
    const expectation = normaliseExpectation(input, { subjects });
    // A part measure asked of a net, or the other way round, is a mistake worth
    // catching now: checked later it produces an empty trace and reads as a
    // circuit that did nothing, which sends the reader looking in the wrong
    // place entirely.
    const isPart = this.#components.has(expectation.subject);
    if (expectation.measure === "voltage" && isPart) {
      throw fail(`${expectation.subject} is a part. Measure the voltage on a net, or the current through the part.`, "CIRCUIT_EXPECT_INVALID");
    }
    if (expectation.measure !== "voltage" && !isPart) {
      throw fail(`${expectation.subject} is a net, and a net has no ${expectation.measure}.`, "CIRCUIT_EXPECT_INVALID");
    }
    if (expectation.measure === "lit" && this.#components.get(expectation.subject)?.kind !== "led") {
      throw fail(`${expectation.subject} is not an LED, so it has no brightness.`, "CIRCUIT_EXPECT_INVALID");
    }
    const id = `E${this.#expectations.size + 1}`;
    const key = `${expectation.subject}:${expectation.measure}:${expectation.condition}:${expectation.value}:${expectation.from}:${expectation.until}`;
    if (this.#expectations.has(key)) {
      return { id: this.#expectations.get(key).id, expectations: this.readExpectations() };
    }
    this.#expectations.set(key, { id, ...expectation });
    this.#cache = null;
    return { id, statement: describeExpectation(expectation), expectations: this.readExpectations() };
  }

  unexpect(id) {
    const name = String(id || "").trim();
    for (const [key, expectation] of [...this.#expectations]) {
      if (expectation.id === name || expectation.subject === name) this.#expectations.delete(key);
    }
    this.#cache = null;
    return { expectations: this.readExpectations() };
  }

  readExpectations() {
    return [...this.#expectations.values()].map((expectation) => ({
      ...expectation, statement: describeExpectation(expectation)
    }));
  }

  // Run the circuit and report, for each expectation, whether it held — with
  // the figure it was judged on.
  //
  // Always from cold. A check that continued from wherever the last run
  // happened to stop would give a different verdict depending on what someone
  // had been doing beforehand, and a test that depends on the order you ran it
  // in is not a test.
  check({ seconds = 0, dt = 0, method = "euler" } = {}) {
    const expectations = [...this.#expectations.values()];
    if (!expectations.length) {
      throw fail("There is nothing to check yet. State an expectation first.", "CIRCUIT_NO_EXPECTATIONS");
    }
    // Long enough to answer every expectation, plus a margin, unless a length
    // was asked for. An expectation about what happens at 800ms checked over a
    // 100ms run reports "nothing was recorded", which is true and useless — and
    // a 5Hz blink checked over 50ms reported "never switched", which is not
    // even true. Each expectation says how long it needs; the run takes the
    // longest.
    const needed = expectations.reduce((longest, expectation) =>
      Math.max(longest, secondsNeededFor(expectation)), 0);
    const duration = Number(seconds) > 0 ? Number(seconds) : Math.max(0.05, needed * 1.05);

    // One probe per distinct subject-and-measure, so two expectations about the
    // same LED are judged on the same recording rather than two of them.
    //
    // Keyed by the probe, not by the measure. Keyed by measure it did not match
    // the user's probes — which are keyed by kind — so "D1 current" and "D1
    // part" were two entries for one question and the page drew the same trace
    // twice.
    const wanted = new Map();
    for (const expectation of expectations) {
      const kind = probeKindFor(expectation.measure);
      wanted.set(`${expectation.subject}:${kind}`, { kind, target: expectation.subject });
    }
    // The user's own probes ride along, so the traces on screen after a check
    // are the ones the verdict was read off.
    for (const probe of this.#probes.values()) wanted.set(`${probe.target}:${probe.kind}`, probe);

    const components = this.#list();
    const result = runTransient(components, {
      seconds: duration, dt, method,
      probes: [...wanted.values()],
      history: createHistory(components),
      chipState: createChipState(components),
      deviceState: createDeviceState(components),
      mcus: createMcus(components, this.#firmware),
      conditions: this.#conditions,
      startTime: 0
    });
    if (!result.ran) {
      return {
        ran: false, findings: result.findings, results: [], seconds: duration,
        summary: "The circuit could not be run, so nothing could be checked."
      };
    }

    const traces = new Map(result.traces.map((trace) => [`${trace.target}:${trace.kind}`, trace.points]));
    const results = expectations.map((expectation) => checkExpectation(
      expectation, traces.get(`${expectation.subject}:${probeKindFor(expectation.measure)}`) || []
    ));

    // The check leaves the circuit where it left it, the same as a run, so the
    // schematic and the traces beside the verdict are the ones it was read off.
    this.#history = result.history;
    this.#chipState = result.chipState;
    this.#deviceState = result.deviceState;
    this.#mcus = result.mcus;
    this.#time = result.time;
    this.#atTime = { nets: result.nodes, currents: result.currents, findings: result.findings };
    this.#traces = copyTraces(result.traces);
    this.#cache = null;

    return {
      ran: true,
      seconds: round(result.time, 12),
      passed: results.filter((entry) => entry.pass).length,
      failed: results.filter((entry) => !entry.pass).length,
      summary: summarise(results),
      results,
      findings: result.findings,
      traces: copyTraces(this.#traces)
    };
  }

  unprobe(target) {
    const name = String(target || "").trim();
    for (const key of [...this.#probes.keys()]) {
      if (key === name || key.startsWith(`${name}:`)) this.#probes.delete(key);
    }
    this.#cache = null;
    return { probes: [...this.#probes.values()] };
  }

  // Run the circuit forward in time.
  //
  // Continues from wherever the last run stopped, so a model can step through a
  // waveform the way a person steps through an experiment, rather than starting
  // from cold each time and having to reason about it.
  run({ seconds, dt = 0, method = "euler", restart = false } = {}) {
    if (!this.#components.size) throw fail("There is nothing to run — the circuit is empty.", "CIRCUIT_EMPTY");
    if (!METHODS.includes(method)) throw fail(`method must be one of: ${METHODS.join(", ")}.`);
    const components = this.#list();
    if (restart || !this.#history) {
      this.#history = createHistory(components);
      this.#chipState = createChipState(components);
      this.#deviceState = createDeviceState(components);
      this.#mcus = createMcus(components, this.#firmware);
      this.#time = 0;
      this.#traces = [];
    }
    const result = runTransient(components, {
      seconds, dt, method,
      probes: [...this.#probes.values()],
      history: this.#history,
      chipState: this.#chipState,
      deviceState: this.#deviceState,
      mcus: this.#mcus,
      conditions: this.#conditions,
      startTime: this.#time
    });
    if (!result.ran) {
      this.#cache = null;
      return { ran: false, findings: result.findings, time: this.#time };
    }
    this.#history = result.history;
    this.#chipState = result.chipState;
    this.#deviceState = result.deviceState;
    this.#mcus = result.mcus;
    this.#time = result.time;
    // Findings belong to the instant too. Without them the schematic reported a
    // motor drawing 685mA while the warning beneath it said 1.97A and was about
    // to burn out — the DC operating point of a motor is a stalled motor, and
    // the numbers and the warning were describing different circuits.
    this.#atTime = { nets: result.nodes, currents: result.currents, findings: result.findings };
    this.#traces = mergeTraces(this.#traces, result.traces);
    this.#cache = null;
    return {
      ran: true,
      time: round(result.time, 12),
      steps: result.steps,
      dt: result.dt,
      method: result.method,
      nets: result.nodes,
      currents: result.currents,
      findings: result.findings,
      traces: copyTraces(this.#traces)
    };
  }

  // Back to the instant before the run started, keeping the circuit as built.
  // The same idea as Reset in the physics sandbox.
  rewind() {
    this.#history = null;
    this.#chipState = null;
    this.#deviceState = null;
    this.#mcus = null;
    this.#time = 0;
    this.#traces = [];
    this.#atTime = null;
    this.#cache = null;
    return this.perceive();
  }

  #netMap() {
    return this.#nets();
  }

  // What the circuit is doing. The same reading a model gets from circuit_look
  // and the page gets from /api/circuit.
  perceive() {
    if (this.#cache) return this.#cache;
    const components = this.#list();
    const dc = solveNetlist(components, { conditions: this.#conditions });
    // Once the circuit has been run, what it is doing is what it was doing at
    // the last step — not what it would settle to if nothing changed. Reporting
    // the operating point of a circuit driven by a 200Hz sine would say every
    // net sits at zero, which is true on average and wrong at every instant.
    const running = this.#atTime !== null;
    const result = running
      ? {
        ...dc,
        nodes: this.#atTime.nets,
        currents: this.#atTime.currents,
        findings: this.#atTime.findings,
        solved: true
      }
      : dc;
    const view = {
      version: CIRCUIT_VERSION,
      parts: components.map((component) => ({
        id: component.id,
        kind: component.kind,
        description: PARTS[component.kind].describe(component.values),
        values: component.values,
        pins: component.pins,
        ...(result.solved && result.currents[component.id] !== undefined
          ? { amps: round(result.currents[component.id], 9) }
          : {})
      })),
      nets: Object.fromEntries(Object.entries(result.nodes).map(([net, volts]) => [net, round(volts, 6)])),
      solved: result.solved,
      findings: result.findings,
      billOfMaterials: billOfMaterials(components),
      // What each output is actually doing: how bright, how fast, what angle.
      // Computed here rather than in the page, like everything else.
      devices: Object.fromEntries(components
        .map((component) => [component.id, deviceView(component, this.#deviceState, result.currents,
          PARTS[component.kind]?.ratings || {})])
        .filter(([, view]) => view)),
      // What each microcontroller is doing: its pins, how many times loop() has
      // come round, anything it printed, and any error it hit.
      mcus: Object.fromEntries([...(this.#mcus || new Map())].map(([id, chip]) => [id, chip.view()])),
      // What each sensor is reading — the quantity, not the voltage it produced.
      // Those are different claims and the whole point of a sensor is the first
      // one: "12.4°C" is what it is for, "2.78V" is only how it says it.
      sensors: Object.fromEntries(components
        .filter((component) => SENSOR_KINDS.includes(component.kind))
        .map((component) => [component.id, sensorView(component, this.#conditions, this.#time)])),
      conditions: this.readConditions(),
      firmware: Object.fromEntries([...this.#firmware].map(([id, source]) => [id, source.split("\n").length])),
      probes: [...this.#probes.values()],
      expectations: this.readExpectations(),
      // Zero until something has been run, which is the honest reading: a
      // circuit that has not been run is not at any particular instant.
      elapsedSeconds: round(this.#time, 12),
      // Whether the numbers above describe a moment in a run or the state the
      // circuit settles to. They are different claims and the interface says
      // which one it is showing.
      reading: running ? "instant" : "steady",
      counts: { parts: components.length, nets: Object.keys(this.#nets()).length }
    };
    this.#cache = view;
    return view;
  }

  // Geometry for the renderer, plus the numbers to write beside it. The page
  // computes neither.
  frame() {
    const components = this.#list();
    const view = this.perceive();
    const drawn = layout(components);
    return {
      ...drawn,
      solved: view.solved,
      nets: view.nets,
      currents: Object.fromEntries(view.parts.filter((part) => part.amps !== undefined).map((part) => [part.id, part.amps])),
      findings: view.findings,
      traces: copyTraces(this.#traces),
      elapsedSeconds: round(this.#time, 12),
      reading: view.reading,
      devices: view.devices,
      mcus: view.mcus,
      sensors: view.sensors,
      conditions: view.conditions
    };
  }

  // What was built, and what is being watched — not what happened last time it
  // was run. A trace is the result of an experiment; saving it inside the
  // circuit would make reopening a file look like it had already been run.
  snapshot() {
    return {
      version: CIRCUIT_VERSION,
      components: this.#list().map((component) => ({
        id: component.id, kind: component.kind, values: { ...component.values }, pins: { ...component.pins }
      })),
      probes: [...this.#probes.values()],
      firmware: Object.fromEntries([...this.#firmware]),
      expectations: this.readExpectations().map(({ statement, ...rest }) => rest),
      conditions: Object.fromEntries([...this.#conditions])
    };
  }

  restore(circuit) {
    if (!circuit || typeof circuit !== "object") throw fail("That is not a saved circuit.");
    const version = Number(circuit.version) || 0;
    if (version > CIRCUIT_VERSION) {
      throw fail(
        `That circuit was saved by a newer version of Evolv (format ${version}, this build reads ${CIRCUIT_VERSION}).`,
        "CIRCUIT_SCENE_VERSION"
      );
    }
    this.clear();
    for (const component of Array.isArray(circuit.components) ? circuit.components : []) {
      if (!PART_KINDS.includes(component?.kind)) throw fail(`A saved circuit names an unknown part: ${component?.kind}`);
      this.add({ kind: component.kind, id: component.id, pins: component.pins || {}, ...(component.values || {}) });
    }
    // Counters follow the restored designators so the next R does not collide
    // with one that came back from the save.
    for (const component of this.#list()) {
      const prefix = DESIGNATORS[component.kind];
      const number = Number(String(component.id).slice(prefix.length));
      if (Number.isFinite(number)) this.#counters.set(prefix, Math.max(this.#counters.get(prefix) || 0, number));
    }
    for (const [id, source] of Object.entries(circuit.firmware || {})) {
      // Firmware for a chip the restored circuit no longer has is dropped
      // rather than fatal, like a probe whose part is gone.
      try { this.writeFirmware(id, source); } catch { /* that chip did not survive */ }
    }
    for (const probe of Array.isArray(circuit.probes) ? circuit.probes : []) {
      // A probe naming something the restored circuit does not have is dropped
      // rather than fatal, the same way physics drops a joint whose object did
      // not survive.
      try { this.probe(probe?.target); } catch { /* the part it watched is gone */ }
    }
    for (const [name, setting] of Object.entries(circuit.conditions || {})) {
      try { this.#conditions.set(name, normaliseCondition(name, setting)); } catch { /* a quantity this build does not have */ }
    }
    for (const expectation of Array.isArray(circuit.expectations) ? circuit.expectations : []) {
      // Same judgement again: a requirement about a part that is no longer here
      // is dropped rather than made fatal. Refusing to open the file would be
      // the worse answer — it would strand the whole design over one stale line.
      try { this.expect(expectation); } catch { /* what it was about is gone */ }
    }
    return this.perceive();
  }

  // One entry point, so a model and the toolbar cannot reach different code.
  apply(action, parameters = {}) {
    switch (action) {
      case "add": return this.add(parameters);
      case "wire": return this.wire(parameters.id, parameters.pin, parameters.net);
      case "adjust": return this.adjust(parameters.id, parameters.values || parameters);
      case "remove": return this.remove(parameters.id);
      case "clear": return this.clear();
      case "run": return this.run(parameters);
      case "probe": return this.probe(parameters.target, parameters.measure);
      case "unprobe": return this.unprobe(parameters.target);
      case "rewind": return this.rewind();
      case "firmware": return this.writeFirmware(parameters.id, parameters.source);
      case "conditions": return this.setConditions(parameters.conditions ?? parameters);
      case "expect": return this.expect(parameters);
      case "unexpect": return this.unexpect(parameters.id ?? parameters.subject);
      case "check": return this.check(parameters);
      case "restore": return this.restore(parameters.circuit);
      default: throw fail(`Unknown circuit action: ${action}. Try one of: ${CIRCUIT_ACTIONS.join(", ")}.`, "CIRCUIT_UNKNOWN_ACTION");
    }
  }

  #list() {
    // Sorted, so everything downstream — the solve, the layout, the snapshot —
    // depends on the circuit rather than on the order parts were added.
    return [...this.#components.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  #nets(source = null) {
    const components = source ? Object.values(source) : this.#list();
    return Object.fromEntries(resolveNets(components).nets);
  }

  #require(id) {
    const component = this.#components.get(String(id || ""));
    if (!component) throw fail(`There is no part called ${id} in this circuit.`, "CIRCUIT_UNKNOWN_PART");
    return component;
  }

  #nextId(kind) {
    const prefix = DESIGNATORS[kind];
    let number = (this.#counters.get(prefix) || 0) + 1;
    while (this.#components.has(`${prefix}${number}`)) number += 1;
    this.#counters.set(prefix, number);
    return `${prefix}${number}`;
  }
}

function validNet(name) {
  const net = String(name).trim();
  if (!NET_PATTERN.test(net)) {
    throw fail(`${JSON.stringify(name)} is not a usable net name. Use a letter followed by letters, digits, _, + or -, such as VCC, GND or N1.`, "CIRCUIT_BAD_NET");
  }
  return net;
}

// Only the fields a part actually has, and only as numbers where numbers are
// meant. A model that sets `ohms` on an LED is not refused — the value is simply
// not a thing an LED has, and carrying it would put nonsense in the save file.
function cleanValues(kind, values = {}) {
  const allowed = new Set(Object.keys(PARTS[kind].defaults));
  const cleaned = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) continue;
    if (typeof PARTS[kind].defaults[key] === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw fail(`${key} has to be a number.`, "INVALID_ARGUMENT");
      cleaned[key] = number;
    } else if (typeof PARTS[kind].defaults[key] === "boolean") {
      cleaned[key] = Boolean(value);
    } else {
      cleaned[key] = String(value);
    }
  }
  return cleaned;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

// Traces accumulate across successive runs so a model can step forward and see
// the whole waveform, not just the last slice of it.
// Traces accumulate across successive runs so a model can step forward and see
// the whole waveform, not just the last slice of it.
//
// Nothing is mutated in place. The first version extended the kept trace's
// points array, which meant the result of an earlier run — already handed to a
// caller — grew a hundred points the next time anything ran. A returned reading
// that changes underneath whoever is holding it is worse than a stale one,
// because nothing about it looks wrong.
function mergeTraces(existing, incoming) {
  const byTarget = new Map(existing.map((trace) => [`${trace.kind}:${trace.target}`, trace]));
  for (const trace of incoming) {
    const key = `${trace.kind}:${trace.target}`;
    const kept = byTarget.get(key);
    byTarget.set(key, kept
      ? { ...kept, points: [...kept.points, ...trace.points].slice(-2_000) }
      : { ...trace, points: [...trace.points] });
  }
  return [...byTarget.values()];
}

// A snapshot of the traces as they stand, so a caller holding one is holding a
// reading rather than a window onto state that keeps moving.
function copyTraces(traces) {
  return traces.map((trace) => ({ ...trace, points: trace.points.map((point) => [...point]) }));
}

export const CIRCUIT_ACTIONS = Object.freeze(["add", "wire", "adjust", "remove", "clear", "run", "probe", "unprobe", "rewind", "firmware", "conditions", "expect", "unexpect", "check", "restore"]);
export { METHODS as CIRCUIT_METHODS, MAX_STEPS_PER_RUN };
export const CIRCUIT_PART_KINDS = PART_KINDS;
export { netlistError };
