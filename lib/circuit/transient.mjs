// What the circuit does next.
//
// A DC operating point answers "what is this doing once nothing is changing".
// That is the right question for a divider and the wrong one for anything with
// a capacitor in it, where the interesting part is the settling. This walks the
// circuit forward in fixed steps, solving it afresh at each one with every
// energy-storing part replaced by what it was holding at the end of the last.
//
// Starting conditions are deliberately zero: capacitors uncharged, inductors
// carrying nothing. SPICE defaults instead to the DC operating point, which for
// an RC across a supply means the capacitor begins fully charged and the run
// shows a flat line — technically defensible and useless for watching something
// charge. Someone pressing Run wants to see it happen.

import { buildIndex, stampComponents, findings, currentsFor } from "./netlist.mjs";
import { solveNonlinear } from "./solver.mjs";
import { PARTS } from "./parts.mjs";
import { createChipState, advanceChips } from "./chips.mjs";
import { createDeviceState, advanceDevices, radiansToRpm } from "./devices.mjs";

// A toy, not a workload — the same reasoning as MAX_STEPS_PER_CALL in
// lib/physics.mjs. Ten thousand steps of a hundred-node circuit is well under a
// second; a model asking for ten million should be told no rather than told
// nothing while the request hangs.
export const MAX_STEPS_PER_RUN = 20_000;
// Every trace point is stored and sent to the browser, so a long run is
// thinned rather than allowed to become megabytes of JSON nobody plots.
export const MAX_TRACE_POINTS = 1_000;

export const METHODS = Object.freeze(["euler", "trapezoidal"]);

export function transientError(message, code = "CIRCUIT_TRANSIENT_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

// Which parts store energy, and therefore need remembering between steps.
export function createHistory(components) {
  const history = new Map();
  for (const component of components) {
    if (component.kind === "capacitor" || component.kind === "inductor") {
      history.set(component.id, { voltage: 0, current: 0 });
    }
  }
  return history;
}

// Choosing a timestep nobody has to think about.
//
// The rule is the fastest thing in the circuit: the smallest RC or L/R time
// constant, and the period of the fastest source. Twenty steps through the
// quicker of the two resolves a curve well enough to read, and a person asking
// to watch a capacitor charge should not have to know what a time constant is
// before they can see one.
export function suggestTimestep(components, duration) {
  const scales = [];
  const resistances = components.filter((component) => component.kind === "resistor")
    .map((component) => Math.max(1, Number(component.values.ohms) || 0));
  const smallestResistance = resistances.length ? Math.min(...resistances) : 1_000;
  for (const component of components) {
    if (component.kind === "capacitor") scales.push(smallestResistance * Math.max(1e-15, Number(component.values.farads) || 0));
    if (component.kind === "inductor") scales.push(Math.max(1e-12, Number(component.values.henries) || 0) / smallestResistance);
    if ((component.kind === "supply" || component.kind === "battery") && component.values.waveform !== "dc") {
      const frequency = Number(component.values.frequency) || 0;
      if (frequency > 0) scales.push(1 / frequency);
    }
  }
  const fastest = scales.length ? Math.min(...scales) : duration / 200;
  // Never fewer than 50 steps across the whole run, never more than the cap.
  const step = Math.min(fastest / 20, duration / 50);
  return Math.max(duration / MAX_STEPS_PER_RUN, step);
}

// Advance the circuit by one step, returning the new state.
function snapshotChips(chips) {
  // Latch state is a handful of booleans per part, so comparing it as text is
  // both adequate and obviously correct.
  return JSON.stringify([...chips.entries()]);
}

export function stepTransient(components, index, history, { dt, time, method, chips = null, devices = null }) {
  // `chips` is the memory of the parts that latch — a 555's flip-flop, a D-type's
  // Q. It is deliberately absent at a DC operating point: an operating point is
  // by definition the state where nothing is changing, so a part that only acts
  // on an edge has no edge to act on.
  const moment = { dt, time, method, history, chips, devices };
  const readFrom = (values) => (component, pin) => {
    const net = component.pins[pin];
    const node = net && index.nodes.has(net) ? index.nodes.get(net) : -1;
    return node >= 0 ? values[node] : 0;
  };
  const solve = () => solveNonlinear(index.size, (system, current, circuit) =>
    stampComponents(components, index, system, circuit, moment)).solution;

  // Solve, then let the latches look at what actually happened, then solve again
  // if one of them moved.
  //
  // Two wrong versions came before this. Updating latches inside the Newton loop
  // meant a flip-flop consumed its own clock edge on the first iteration and
  // held a different value for the rest, so the answer depended on how many
  // iterations convergence happened to need. Moving them out but reading the
  // *previous* step's solution fixed that and introduced a full timestep of
  // comparator lag: the 555 astable slipped from 13.89Hz to 13.05Hz against a
  // theoretical 13.85.
  //
  // A latch reads this instant, and if it flips, the circuit responds to it in
  // this instant too. One extra solve, no lag, and the state is fixed for the
  // whole of each solve so the result does not depend on iteration counts.
  let solution = solve();
  if (chips) {
    const before = snapshotChips(chips);
    advanceChips(components, readFrom(solution), chips);
    if (snapshotChips(chips) !== before) solution = solve();
  }
  const currents = currentsFor(components, index, solution, moment);
  // Everything mechanical moves last, from the currents the solve just produced
  // — a rotor accelerates because of the current that flowed, not the other way
  // round, and doing it in the other order would put the motor a step ahead of
  // its own electricity.
  advanceDevices(components, { read: readFrom(solution), currents, state: devices, dt, time });
  // History is updated only after the step converged, from the settled values,
  // so what the next step remembers is what actually happened rather than an
  // intermediate Newton iterate.
  const next = new Map();
  for (const [id, past] of history) {
    const component = components.find((item) => item.id === id);
    const [first, second] = PARTS[component.kind].pins;
    const voltage = readNode(index, component, first, solution) - readNode(index, component, second, solution);
    next.set(id, { voltage, current: currents.get(id) ?? past.current });
  }
  return { solution, currents, history: next };
}

function readNode(index, component, pin, solution) {
  const net = component.pins[pin];
  const node = net && index.nodes.has(net) ? index.nodes.get(net) : -1;
  return node >= 0 ? solution[node] : 0;
}

// Run for a stretch of time, recording what the probes asked for.
//
// `probes` name a net or a part; a net records its voltage, a part its current.
// Nothing else is recorded, because a trace of every node of every part for
// twenty thousand steps is tens of megabytes and no one plots it.
export function runTransient(components, { seconds, dt = 0, method = "euler", probes = [], history = null, chipState = null, deviceState = null, startTime = 0 }) {
  if (!METHODS.includes(method)) {
    throw transientError(`method must be one of: ${METHODS.join(", ")}.`);
  }
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw transientError("Give a length of time to run for, in seconds.");
  }
  const index = buildIndex(components);
  const structural = findings(components, index, null, new Map());
  if (structural.some((item) => item.severity === "error")) {
    return {
      ran: false, findings: structural, traces: [], time: startTime, steps: 0,
      history: history || createHistory(components),
      chipState: chipState || createChipState(components),
      deviceState: deviceState || createDeviceState(components)
    };
  }

  const step = dt > 0 ? Number(dt) : suggestTimestep(components, duration);
  const requested = Math.ceil(duration / step);
  if (requested > MAX_STEPS_PER_RUN) {
    throw transientError(
      `That would take ${requested.toLocaleString()} steps and the limit is ${MAX_STEPS_PER_RUN.toLocaleString()}. Run for less time, or set a larger dt.`,
      "CIRCUIT_RUN_TOO_LONG"
    );
  }

  let state = history || createHistory(components);
  const chips = chipState || createChipState(components);
  const devices = deviceState || createDeviceState(components);
  let time = startTime;
  const recorded = probes.map((probe) => ({ ...probe, points: [] }));
  // Thin as we go rather than at the end: keeping every step and sampling later
  // means holding the whole run in memory to throw most of it away.
  const keepEvery = Math.max(1, Math.ceil(requested / MAX_TRACE_POINTS));

  let last = null;
  for (let stepIndex = 0; stepIndex < requested; stepIndex += 1) {
    // The first step is always backward Euler, whatever was asked for.
    //
    // Trapezoidal needs the current each reactive part was carrying at the end
    // of the previous step, and at t=0 there is no previous step — the history
    // says zero, when a capacitor across a resistor is actually passing V/R the
    // instant the supply appears. Seeding trapezoidal with that wrong figure
    // injects an error at the first step that it then carries the whole way,
    // which is why it measured no better than Euler until this was here. SPICE
    // does the same thing for the same reason.
    const stepMethod = stepIndex === 0 ? "euler" : method;
    // Time advances first, and everything is then solved *at* that instant.
    //
    // Backward Euler is backward precisely because it evaluates at the end of
    // the step, not the start. Stamping the source at the old time and then
    // labelling the answer with the new one was wrong twice over: it drove the
    // circuit with a value half a step stale, and every recorded point carried
    // a timestamp one step later than the instant it described. On a 200Hz sine
    // sampled at 50µs that is a visible phase error in the plot, and it would
    // have been read as the circuit's behaviour rather than the solver's.
    time += step;
    const result = stepTransient(components, index, state, { dt: step, time, method: stepMethod, chips, devices });
    state = result.history;
    last = result;
    if (stepIndex % keepEvery !== 0 && stepIndex !== requested - 1) continue;
    for (const probe of recorded) {
      const value = probe.kind === "net"
        ? nodeVoltage(index, probe.target, result.solution)
        : probe.kind === "speed"
          ? radiansToRpm(devices.get(probe.target)?.speed || 0)
          : probe.kind === "angle"
            ? (devices.get(probe.target)?.angle || 0)
            : (result.currents.get(probe.target) ?? 0);
      probe.points.push([round(time, 12), round(value, 9)]);
    }
  }

  const nodes = {};
  for (const [net, node] of index.nodes) nodes[net] = round(node >= 0 ? last.solution[node] : 0, 6);
  return {
    ran: true,
    time,
    steps: requested,
    dt: step,
    method,
    nodes,
    currents: Object.fromEntries([...last.currents].map(([id, value]) => [id, round(value, 9)])),
    findings: findings(components, index, last.solution, last.currents),
    traces: recorded,
    history: state,
    chipState: chips,
    deviceState: devices
  };
}

function nodeVoltage(index, net, solution) {
  const node = index.nodes.get(net);
  if (node === undefined) return 0;
  return node >= 0 ? solution[node] : 0;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}
