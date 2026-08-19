// A circuit as a list of parts and what they are joined to.
//
// This is the netlist, and it is deliberately the only way a circuit is
// described. A model says "a 220Ω resistor from N1 to N2" and never places
// anything on a grid — coordinates are the renderer's problem, computed in
// lib/circuit/layout.mjs. A model asked to lay out a schematic by hand produces
// crossed, unreadable wiring, and none of that would make the circuit any more
// or less correct.
//
// Nets are named by whoever builds the circuit. Two pins on the same net name
// are joined by a wire; that is all a wire is here. Ground is special only
// because the solver needs a reference: any net a ground part touches becomes
// node zero.

import { PARTS, partModel, partRatings, formatAmps, formatOhms, formatVolts } from "./parts.mjs";
import { solveNonlinear, solverError } from "./solver.mjs";

// A toy, not a workload. These are what stop a runaway model turning a sandbox
// into a job — the same reasoning as MAX_BODIES in lib/physics.mjs.
export const MAX_COMPONENTS = 120;
export const MAX_NETS = 200;

// Contact resistance of a closed switch, and leakage across an open one. Both
// are real: no switch is a perfect short, and none is a perfect open. Using
// finite values rather than ideal ones also keeps the matrix solvable, which
// matters more than the third decimal place of either number.
const CLOSED_SWITCH_OHMS = 0.01;
const OPEN_SWITCH_OHMS = 1e9;

export function netlistError(message, code = "CIRCUIT_INVALID") {
  return Object.assign(new Error(message), { message, code, status: 400, expose: true });
}

const GROUND_NAMES = new Set(["gnd", "ground", "0", "vss"]);

export function isGroundName(name) {
  return GROUND_NAMES.has(String(name || "").trim().toLowerCase());
}

// Which nets exist, and which single net is ground.
//
// Ground is whichever nets a `ground` part sits on, plus anything conventionally
// named. Several grounds are one ground — that is what the symbol means on a
// schematic, and treating them as separate nets is a mistake a beginner would
// never make on paper but every netlist tool has to handle.
export function resolveNets(components) {
  const nets = new Map();
  const grounded = new Set();
  for (const component of components) {
    const definition = PARTS[component.kind];
    for (const pin of definition.pins) {
      const net = component.pins[pin];
      if (!net) continue;
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net).push({ component: component.id, pin });
      if (component.kind === "ground" || isGroundName(net)) grounded.add(net);
    }
  }
  return { nets, grounded };
}

// Turn a netlist into node indices the solver can use.
//
// Ground nets map to -1, which the solver reads as "not an unknown". Every other
// net gets a row. Voltage sources each get one more row for their own current.
export function buildIndex(components) {
  const { nets, grounded } = resolveNets(components);
  const nodes = new Map();
  let next = 0;
  // Sorted, so node numbering depends only on the netlist and not on the order
  // parts happened to be added. Two identical circuits must produce identical
  // matrices or nothing downstream is reproducible.
  for (const net of [...nets.keys()].sort()) {
    nodes.set(net, grounded.has(net) ? -1 : next++);
  }
  const sources = components
    .filter((component) => component.kind === "battery" || component.kind === "supply")
    .sort((left, right) => left.id.localeCompare(right.id));
  const branches = new Map();
  // A source with internal resistance is a perfect source behind a resistor, so
  // it needs a node between the two. Allocated here rather than faked with a
  // conductance across the terminals, because the resistor has to be in series
  // with the source and there is no way to say that without the node.
  const internals = new Map();
  for (const source of sources) {
    branches.set(source.id, next++);
    if (Number(source.values?.resistance) > 0) internals.set(source.id, next++);
  }
  return { nets, grounded, nodes, branches, internals, size: next };
}

const nodeOf = (index, component, pin) => {
  const net = component.pins[pin];
  return net && index.nodes.has(net) ? index.nodes.get(net) : -1;
};

// Stamp every component into one iteration of the solve.
function stampAll(components, index, system, circuit) {
  for (const component of components) {
    const { kind, values } = component;
    switch (kind) {
      case "resistor": {
        const ohms = Math.max(1e-6, Number(values.ohms) || 0);
        system.stampConductance(nodeOf(index, component, "a"), nodeOf(index, component, "b"), 1 / ohms);
        break;
      }
      case "potentiometer": {
        // Two resistors meeting at the wiper, which is exactly what one is.
        const ohms = Math.max(1e-6, Number(values.ohms) || 0);
        const position = Math.min(1, Math.max(0, Number(values.position ?? 0.5)));
        const upper = Math.max(1e-6, ohms * position);
        const lower = Math.max(1e-6, ohms * (1 - position));
        system.stampConductance(nodeOf(index, component, "a"), nodeOf(index, component, "wiper"), 1 / upper);
        system.stampConductance(nodeOf(index, component, "wiper"), nodeOf(index, component, "b"), 1 / lower);
        break;
      }
      case "switch": {
        const ohms = values.closed ? CLOSED_SWITCH_OHMS : OPEN_SWITCH_OHMS;
        system.stampConductance(nodeOf(index, component, "a"), nodeOf(index, component, "b"), 1 / ohms);
        break;
      }
      case "battery":
      case "supply": {
        const positive = nodeOf(index, component, "positive");
        const negative = nodeOf(index, component, "negative");
        const resistance = Number(values.resistance) || 0;
        const internal = index.internals.get(component.id);
        if (internal === undefined) {
          system.stampVoltageSource(positive, negative, index.branches.get(component.id), Number(values.volts) || 0);
          break;
        }
        // Ideal source from the internal node to the negative terminal, then its
        // own resistance from the internal node out to the positive terminal.
        system.stampVoltageSource(internal, negative, index.branches.get(component.id), Number(values.volts) || 0);
        system.stampConductance(internal, positive, 1 / resistance);
        break;
      }
      case "diode":
      case "led": {
        circuit.diode(component.id, nodeOf(index, component, "anode"), nodeOf(index, component, "cathode"),
          partModel(kind, values) || {});
        break;
      }
      // At a DC operating point a capacitor is an open circuit and an inductor
      // is a short. This is not an approximation — it is what they are once
      // nothing is changing, and it is the answer a person would give.
      case "capacitor": {
        system.stampConductance(nodeOf(index, component, "a"), nodeOf(index, component, "b"), 1e-12);
        break;
      }
      case "inductor": {
        system.stampConductance(nodeOf(index, component, "a"), nodeOf(index, component, "b"), 1 / 1e-3);
        break;
      }
      case "ground":
        break;
      default:
        throw netlistError(`Evolv does not know how to simulate a ${kind}.`, "CIRCUIT_UNKNOWN_PART");
    }
  }
}

const voltageAt = (solution, node) => (node >= 0 ? solution[node] : 0);

// What current flows through each part, once the voltages are known.
function currentsFor(components, index, solution) {
  const currents = new Map();
  for (const component of components) {
    const { kind, values } = component;
    if (kind === "ground") continue;
    if (kind === "battery" || kind === "supply") {
      // The branch unknown is the current into the positive terminal; a source
      // delivering power reads negative there, which is a sign convention
      // nobody outside a solver shares. Flipped here, once.
      currents.set(component.id, -solution[index.branches.get(component.id)]);
      continue;
    }
    if (kind === "potentiometer") {
      const across = voltageAt(solution, nodeOf(index, component, "a")) - voltageAt(solution, nodeOf(index, component, "wiper"));
      const ohms = Math.max(1e-6, (Number(values.ohms) || 0) * Math.min(1, Math.max(0, Number(values.position ?? 0.5))));
      currents.set(component.id, across / ohms);
      continue;
    }
    const [first, second] = PARTS[kind].pins;
    const across = voltageAt(solution, nodeOf(index, component, first)) - voltageAt(solution, nodeOf(index, component, second));
    let ohms = null;
    if (kind === "resistor") ohms = Math.max(1e-6, Number(values.ohms) || 0);
    else if (kind === "switch") ohms = values.closed ? CLOSED_SWITCH_OHMS : OPEN_SWITCH_OHMS;
    else if (kind === "capacitor") ohms = 1e12;
    else if (kind === "inductor") ohms = 1e-3;
    if (ohms !== null) {
      currents.set(component.id, across / ohms);
      continue;
    }
    if (kind === "diode" || kind === "led") {
      const model = partModel(kind, values) || {};
      const scale = (model.emission || 1) * 0.025852;
      const saturation = model.saturationCurrent || 1e-14;
      // Recomputed from the settled voltage rather than carried out of the last
      // Newton iteration, so the reported current and the reported voltage
      // describe the same instant.
      const exponent = Math.min(80, across / scale);
      currents.set(component.id, saturation * (Math.exp(exponent) - 1));
      continue;
    }
    currents.set(component.id, 0);
  }
  return currents;
}

// Everything wrong with this circuit that Evolv can state as a fact.
//
// Deliberately not a style guide. "An LED wants a series resistor" is good
// advice and it is an opinion; "this LED is passing 31mA and it is rated for 20"
// is a measurement. Only the second kind belongs here, because a sandbox that
// nags is one people stop reading.
export function findings(components, index, solution, currents) {
  const found = [];
  const { nets, grounded } = index;

  if (grounded.size === 0) {
    found.push({
      severity: "error", code: "NO_GROUND",
      message: "This circuit has no ground. Voltage is a difference, so without a reference point there is no single answer — add a ground symbol to the negative side of the supply."
    });
  }

  for (const [net, connections] of nets) {
    if (grounded.has(net)) continue;
    if (connections.length < 2) {
      found.push({
        severity: "error", code: "FLOATING_NET", net,
        message: `Net ${net} has only one thing connected to it (${connections[0]?.component} ${connections[0]?.pin}). Current has nowhere to go, so nothing will happen here.`
      });
    }
  }

  for (const component of components) {
    if (component.kind !== "battery" && component.kind !== "supply") continue;
    const positive = component.pins.positive;
    const negative = component.pins.negative;
    if (positive && positive === negative) {
      found.push({
        severity: "error", code: "SOURCE_SHORTED", component: component.id,
        message: `${component.id} has both terminals on net ${positive}. That is a dead short across the supply — on a bench this is the wire that gets hot.`
      });
    }
  }

  if (solution) {
    for (const component of components) {
      const current = Math.abs(currents.get(component.id) ?? 0);
      const ratings = partRatings(component.kind, component.values);
      if (Number.isFinite(ratings.amps) && current > ratings.amps) {
        found.push({
          severity: "error", code: "OVER_CURRENT", component: component.id,
          message: `${component.id} is passing ${formatAmps(current)} and is rated for ${formatAmps(ratings.amps)}. On a bench this part fails, usually within seconds.`
        });
      }
      if (Number.isFinite(ratings.watts)) {
        const [first, second] = PARTS[component.kind].pins;
        const across = Math.abs(
          voltageAt(solution, nodeOf(index, component, first)) - voltageAt(solution, nodeOf(index, component, second))
        );
        const watts = across * current;
        if (watts > ratings.watts) {
          found.push({
            severity: "error", code: "OVER_POWER", component: component.id,
            message: `${component.id} is dissipating ${watts.toFixed(2)}W and is a ${ratings.watts}W part. It will discolour, then fail — fit a larger one or raise the resistance.`
          });
        }
      }
      if (Number.isFinite(ratings.reverseVolts)) {
        const [anode, cathode] = PARTS[component.kind].pins;
        const reverse = voltageAt(solution, nodeOf(index, component, cathode)) - voltageAt(solution, nodeOf(index, component, anode));
        if (reverse > ratings.reverseVolts) {
          found.push({
            severity: "error", code: "OVER_REVERSE_VOLTAGE", component: component.id,
            message: `${component.id} has ${formatVolts(reverse)} across it backwards and is rated for ${formatVolts(ratings.reverseVolts)}. It will break down and conduct.`
          });
        }
      }
      if (Number.isFinite(ratings.volts) && component.kind === "capacitor") {
        const across = Math.abs(
          voltageAt(solution, nodeOf(index, component, "a")) - voltageAt(solution, nodeOf(index, component, "b"))
        );
        if (across > ratings.volts) {
          found.push({
            severity: "error", code: "OVER_VOLTAGE", component: component.id,
            message: `${component.id} has ${formatVolts(across)} across it and is a ${ratings.volts}V part.`
          });
        }
      }
    }
  }
  return found;
}

// Solve a netlist at its DC operating point.
//
// A circuit that cannot be solved is not an exception to swallow: the reason is
// returned as a finding beside the parts, because a broken circuit is a thing to
// look at rather than an error to dismiss. That is the same judgement the tool
// layer makes about failed tool calls — the failure is information.
export function solveNetlist(components) {
  if (!Array.isArray(components)) throw netlistError("A circuit is a list of parts.");
  if (components.length === 0) {
    return { solved: false, nodes: {}, currents: {}, findings: [], iterations: 0 };
  }
  const index = buildIndex(components);
  const structural = findings(components, index, null, new Map());
  // Structural faults make the numbers meaningless, so they are reported
  // without a solve rather than alongside a fabricated one.
  if (structural.some((item) => item.severity === "error")) {
    return { solved: false, nodes: {}, currents: {}, findings: structural, iterations: 0 };
  }
  let solution;
  let iterations = 0;
  try {
    const result = solveNonlinear(index.size, (system, current, circuit) => stampAll(components, index, system, circuit));
    solution = result.solution;
    iterations = result.iterations;
  } catch (error) {
    if (error.code && String(error.code).startsWith("CIRCUIT_")) {
      return {
        solved: false, nodes: {}, currents: {}, iterations: 0,
        findings: [...structural, { severity: "error", code: error.code, message: error.message }]
      };
    }
    throw error;
  }
  const currents = currentsFor(components, index, solution);
  const nodes = {};
  for (const [net, node] of index.nodes) nodes[net] = node >= 0 ? solution[node] : 0;
  return {
    solved: true,
    nodes,
    currents: Object.fromEntries(currents),
    findings: findings(components, index, solution, currents),
    iterations
  };
}

// A bill of materials: what you would actually order to build this.
export function billOfMaterials(components) {
  const lines = new Map();
  for (const component of components) {
    if (component.kind === "ground") continue;
    const definition = PARTS[component.kind];
    const description = definition.describe(component.values || {});
    const entry = lines.get(description) || { description, kind: component.kind, quantity: 0, references: [] };
    entry.quantity += 1;
    entry.references.push(component.id);
    lines.set(description, entry);
  }
  return [...lines.values()]
    .map((line) => ({ ...line, references: line.references.sort() }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.description.localeCompare(right.description));
}

export { formatOhms };
