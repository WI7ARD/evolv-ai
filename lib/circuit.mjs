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
  switch: "SW", potentiometer: "RV", battery: "BT", supply: "PS", ground: "GND"
});

const NET_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]{0,23}$/;

function fail(message, code = "CIRCUIT_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

export class CircuitService {
  #components = new Map();
  #counters = new Map();
  #cache = null;

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
    this.#cache = null;
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
    this.#cache = null;
    return { id, pins: next };
  }

  adjust(id, values) {
    const component = this.#require(id);
    const next = { ...component.values, ...cleanValues(component.kind, values) };
    this.#components.set(id, { ...component, values: next });
    this.#cache = null;
    return { id, values: next };
  }

  remove(id) {
    this.#require(id);
    this.#components.delete(id);
    this.#cache = null;
    return { removed: id };
  }

  clear() {
    this.#components.clear();
    this.#counters.clear();
    this.#cache = null;
    return this.perceive();
  }

  // What the circuit is doing. The same reading a model gets from circuit_look
  // and the page gets from /api/circuit.
  perceive() {
    if (this.#cache) return this.#cache;
    const components = this.#list();
    const result = solveNetlist(components);
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
      findings: view.findings
    };
  }

  snapshot() {
    return {
      version: CIRCUIT_VERSION,
      components: this.#list().map((component) => ({
        id: component.id, kind: component.kind, values: { ...component.values }, pins: { ...component.pins }
      }))
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

export const CIRCUIT_ACTIONS = Object.freeze(["add", "wire", "adjust", "remove", "clear", "restore"]);
export const CIRCUIT_PART_KINDS = PART_KINDS;
export { netlistError };
