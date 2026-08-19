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

import { PARTS, partModel, partRatings, formatAmps, formatOhms, formatVolts, sourceVoltage } from "./parts.mjs";
import { solveNonlinear, solverError } from "./solver.mjs";
import { chipDriver, CHIP_MODELS } from "./chips.mjs";
import { motorCompanion } from "./devices.mjs";

// A toy, not a workload. These are what stop a runaway model turning a sandbox
// into a job — the same reasoning as MAX_BODIES in lib/physics.mjs.
export const MAX_COMPONENTS = 120;
export const MAX_NETS = 200;

// Contact resistance of a closed switch, and leakage across an open one. Both
// are real: no switch is a perfect short, and none is a perfect open. Using
// finite values rather than ideal ones also keeps the matrix solvable, which
// matters more than the third decimal place of either number.
// The rail a chip's rated draw is quoted against. Used only to turn a current
// in the datasheet into a resistance the matrix can hold.
const NOMINAL_LOGIC_VOLTS = 5;
const CLOSED_SWITCH_OHMS = 0.01;
const OPEN_SWITCH_OHMS = 1e9;

export function netlistError(message, code = "CIRCUIT_INVALID") {
  return Object.assign(new Error(message), { message, code, status: 400, expose: true });
}

// Which pins each part drives to a voltage of its own choosing.
//
// An op-amp, a logic gate, a 555 and a regulator are all the same thing to the
// solver — something that decides an output voltage and pushes towards it
// through an output resistance. Each such pin needs a branch unknown for its
// current and an internal node to put the resistance behind, which is what this
// table is for.
export const DRIVEN_PINS = Object.freeze({
  opamp: ["out"],
  regulator: ["output"],
  gate: ["out"],
  flipflop: ["q", "qn"],
  timer555: ["out"],
  mcupin: ["pin"],
  // Every leg of the microcontroller is driven, because an input pin is not
  // "not stamped" — it is a very large resistance, which is a different thing
  // and the difference is a matrix that has an answer.
  mcu: ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "a0", "a1", "a2", "a3"]
});

function chipGain(component) {
  return (CHIP_MODELS.opamp[component.values?.part] || CHIP_MODELS.opamp.LM358).gain;
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
  // Driven outputs, keyed by part and pin so a flip-flop's Q and Q-bar get one
  // each. Sorted for the same reason everything else here is: two identical
  // circuits must produce identical matrices.
  const drivers = new Map();
  for (const component of [...components].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const pin of DRIVEN_PINS[component.kind] || []) {
      if (!component.pins[pin]) continue;
      drivers.set(`${component.id}:${pin}`, { branch: next++, internal: next++ });
    }
  }
  return { nets, grounded, nodes, branches, internals, drivers, size: next };
}

const nodeOf = (index, component, pin) => {
  const net = component.pins[pin];
  return net && index.nodes.has(net) ? index.nodes.get(net) : -1;
};

// Stamp every component into one iteration of the solve.
//
// `moment` is absent at a DC operating point and present during a transient
// run, carrying the timestep, the time, and what each energy-storing part was
// doing at the end of the previous step. A capacitor and an inductor are the
// only parts that behave differently between the two, which is the whole
// difference between "what is this circuit doing" and "what does it do next".
export function stampComponents(components, index, system, circuit, moment = null) {
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
        // A source that changes over time is read at this instant. At a DC
        // operating point there is no instant, so it is read at zero — which is
        // what a bench meter shows before you press start.
        const volts = sourceVoltage(values, moment ? moment.time : 0);
        if (internal === undefined) {
          system.stampVoltageSource(positive, negative, index.branches.get(component.id), volts);
          break;
        }
        // Ideal source from the internal node to the negative terminal, then its
        // own resistance from the internal node out to the positive terminal.
        system.stampVoltageSource(internal, negative, index.branches.get(component.id), volts);
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
      //
      // Over time they are neither, and the companion model below is how a
      // solver that only knows about resistors and current sources represents
      // something with memory: for one timestep, a capacitor is a conductance in
      // parallel with a current source that carries what it was holding.
      case "capacitor": {
        const a = nodeOf(index, component, "a");
        const b = nodeOf(index, component, "b");
        if (!moment) {
          system.stampConductance(a, b, 1e-12);
          break;
        }
        const farads = Math.max(1e-15, Number(values.farads) || 0);
        const past = moment.history.get(component.id) || { voltage: 0, current: 0 };
        const { conductance, source } = capacitorCompanion(farads, moment.dt, past, moment.method);
        system.stampConductance(a, b, conductance);
        system.stampCurrent(a, b, source);
        break;
      }
      case "inductor": {
        const a = nodeOf(index, component, "a");
        const b = nodeOf(index, component, "b");
        if (!moment) {
          system.stampConductance(a, b, 1 / 1e-3);
          break;
        }
        const henries = Math.max(1e-12, Number(values.henries) || 0);
        const past = moment.history.get(component.id) || { voltage: 0, current: 0 };
        const { conductance, source } = inductorCompanion(henries, moment.dt, past, moment.method);
        system.stampConductance(a, b, conductance);
        system.stampCurrent(a, b, source);
        break;
      }
      case "ground":
        break;

      // A motor is a winding, an inductance and a back-EMF in series. At rest —
      // and at a DC operating point, where nothing is turning — the back-EMF is
      // zero and it is simply its winding resistance, which is why a stalled
      // motor draws so much. Once it is spinning the back-EMF opposes the
      // supply and the current falls away on its own.
      case "motor": {
        const a = nodeOf(index, component, "positive");
        const b = nodeOf(index, component, "negative");
        if (!moment) {
          system.stampConductance(a, b, 1 / Math.max(0.01, Number(values.resistance) || 3));
          break;
        }
        const past = moment.devices?.get(component.id) || { speed: 0, current: 0 };
        const { conductance, source } = motorCompanion(values, moment.dt, past);
        system.stampConductance(a, b, conductance);
        system.stampCurrent(a, b, source);
        break;
      }

      // A servo's signal pin is an input and draws almost nothing; the motor
      // inside it is what loads the supply.
      case "servo": {
        system.stampConductance(nodeOf(index, component, "signal"), nodeOf(index, component, "gnd"), 1 / 100_000);
        system.stampConductance(nodeOf(index, component, "vcc"), nodeOf(index, component, "gnd"), 1 / 150);
        break;
      }

      case "buzzer": {
        system.stampConductance(
          nodeOf(index, component, "a"), nodeOf(index, component, "b"),
          1 / Math.max(1, Number(values.resistance) || 32)
        );
        break;
      }

      // A multi-LED package is exactly what it looks like: several diodes
      // sharing a pin. Each gets its own Newton junction, keyed by segment, so
      // one lit segment does not drag the others' operating points around.
      case "rgbled":
      case "sevenseg": {
        const commonNode = nodeOf(index, component, "common");
        const anodeCommon = String(values.common || "cathode") === "anode";
        const segments = PARTS[kind].pins.filter((pin) => pin !== "common");
        const colours = { red: "red", green: "green", blue: "blue" };
        for (const segment of segments) {
          if (!component.pins[segment]) continue;
          const pinNode = nodeOf(index, component, segment);
          const model = partModel("led", { colour: colours[segment] || "red" }) || {};
          if (anodeCommon) circuit.diode(`${component.id}:${segment}`, commonNode, pinNode, model);
          else circuit.diode(`${component.id}:${segment}`, pinNode, commonNode, model);
        }
        break;
      }

      // The microcontroller drives each of its legs according to what firmware
      // has set that pin to. The chip object holds that state; this only stamps
      // it, exactly like any other driven output.
      case "mcu": {
        const chip = moment?.mcus?.get(component.id);
        const driven = chip ? chip.drive() : {};
        const ground = nodeOf(index, component, "gnd");
        // The chip's own draw, before it drives anything.
        //
        // Without this a microcontroller reads 0A in the parts table, which is
        // wrong by the largest single item in most battery budgets — someone
        // sizing a cell off that figure would be out by an order of magnitude.
        // Stamped as a resistance rather than a current source: it draws the
        // rated figure at its nominal supply and less as the rail sags, which
        // is roughly how CMOS behaves, and unlike a fixed current source it
        // cannot go on drawing from a rail that has collapsed.
        const active = Math.max(0, Number(component.values?.activeAmps) || 0);
        if (active > 0) {
          system.stampConductance(nodeOf(index, component, "vcc"), ground, active / NOMINAL_LOGIC_VOLTS);
        }
        for (const pin of DRIVEN_PINS.mcu) {
          const allocation = index.drivers.get(`${component.id}:${pin}`);
          if (!allocation) continue;
          const setting = driven[pin] || { volts: 0, reference: "gnd", resistance: 1e9 };
          // Each pin says which supply leg it hangs off — see Mcu#drive. A pin
          // driving high takes its current off Vcc, the same as any other
          // push-pull output.
          const from = setting.reference === "vcc" ? nodeOf(index, component, "vcc") : ground;
          system.stampVoltageSource(allocation.internal, from, allocation.branch, setting.volts);
          system.stampConductance(allocation.internal, nodeOf(index, component, pin), 1 / Math.max(0.01, setting.resistance));
        }
        break;
      }

      case "opamp":
      case "regulator":
      case "gate":
      case "flipflop":
      case "timer555":
      case "mcupin": {
        // Read this part's pins from wherever the solve has got to, ask it what
        // it wants to drive, and stamp that as a source behind its output
        // resistance. It is re-asked every Newton iteration, which is what lets
        // a comparator flip and an op-amp find its own feedback point.
        const read = (pin) => {
          const node = nodeOf(index, component, pin);
          return node >= 0 ? circuit.solution[node] : 0;
        };
        const memory = moment?.chips?.get(component.id) ?? null;
        const driver = chipDriver(component, read, memory);
        const reference = driver?.reference ? nodeOf(index, component, driver.reference) : -1;
        // Which node a pin's driver sits on top of, and therefore where its
        // current comes from.
        //
        // An output driving high is a switch to the positive rail, so its
        // current has to be taken off that rail. Stamped against ground instead
        // — which every driver here used to be — a chip lighting an LED created
        // the current out of nothing: the LED drew 7.94mA, the chip reported
        // supplying it, and the supply reported delivering none of it. On a
        // battery-powered board that is the difference between a plausible
        // current budget and a fictional one.
        //
        // A driver names its reference; `volts` is then the drop across the
        // source, from that reference to the pin, rather than a voltage
        // measured from ground.
        const referenceFor = (pin) => {
          const named = driver?.references?.[pin];
          return named ? nodeOf(index, component, named) : reference;
        };

        // A pin that was given a branch and an internal node must always be
        // stamped, even when the part is driving nothing.
        //
        // An unpowered chip — or any chip at all on the first iteration, when
        // every node still reads zero and so every supply looks absent —
        // returned null and stamped nothing, leaving two empty rows in the
        // matrix. An empty row has no solution, so a NAND gate lighting an LED
        // reported that the circuit had no single answer. Not driving a pin is
        // a real state and it has a real representation: nothing, through a very
        // large resistance.
        const IDLE = { volts: 0, resistance: 1e9 };

        // An op-amp that is not clipping goes in as a controlled source, so its
        // gain and its feedback are solved together rather than chased. Once it
        // clips it is just a source sitting at a rail, and that is stamped as
        // one — a discrete state, which settles in an iteration or two instead
        // of never.
        if (kind === "opamp" && driver && !driver.saturated) {
          const allocation = index.drivers.get(`${component.id}:out`);
          if (allocation) {
            system.stampControlledSource(
              allocation.internal, reference, allocation.branch,
              nodeOf(index, component, "inPlus"), nodeOf(index, component, "inMinus"),
              chipGain(component)
            );
            system.stampConductance(allocation.internal, nodeOf(index, component, "out"), 1 / Math.max(0.01, driver.resistance));
          }
          break;
        }

        for (const pin of DRIVEN_PINS[kind]) {
          const allocation = index.drivers.get(`${component.id}:${pin}`);
          if (!allocation) continue;
          const active = driver || IDLE;
          // Q-bar is the same driver read the other way round.
          const volts = driver?.pins?.[pin] ?? active.volts;
          system.stampVoltageSource(allocation.internal, referenceFor(pin), allocation.branch, volts);
          system.stampConductance(allocation.internal, nodeOf(index, component, pin), 1 / Math.max(0.01, active.resistance));
        }
        // The 555's discharge pin is an open collector: a path to ground while
        // the latch is reset, and nothing at all while it is set. That is what
        // makes the timing capacitor charge and discharge through different
        // resistors, which is the whole of how a 555 astable works.
        if (driver && Number.isFinite(driver.discharge) && component.pins.discharge) {
          system.stampConductance(nodeOf(index, component, "discharge"), nodeOf(index, component, "gnd"), 1 / driver.discharge);
        }
        break;
      }

      default:
        throw netlistError(`Evolv does not know how to simulate a ${kind}.`, "CIRCUIT_UNKNOWN_PART");
    }
  }
}

// A capacitor over one timestep, as a conductance and a current source.
//
// Backward Euler is the default and it is the right default: it damps rather
// than rings, so a step into a resonant circuit settles instead of oscillating
// forever from numerical error alone. Trapezoidal is more accurate per step and
// will ring on a sharp edge — offered, not chosen for anyone.
export function capacitorCompanion(farads, dt, past, method = "euler") {
  if (method === "trapezoidal") {
    const conductance = (2 * farads) / dt;
    return { conductance, source: -((conductance * past.voltage) + past.current) };
  }
  const conductance = farads / dt;
  return { conductance, source: -(conductance * past.voltage) };
}

export function inductorCompanion(henries, dt, past, method = "euler") {
  if (method === "trapezoidal") {
    const conductance = dt / (2 * henries);
    return { conductance, source: past.current + (conductance * past.voltage) };
  }
  return { conductance: dt / henries, source: past.current };
}

const voltageAt = (solution, node) => (node >= 0 ? solution[node] : 0);

// What current flows through each part, once the voltages are known.
function currentsFor(components, index, solution, moment = null) {
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
    // A microcontroller reports what it takes from the supply, not what one leg
    // is doing.
    //
    // Every other driven part here has one output, so "the current out of the
    // first output" is the whole story. A chip with twelve legs is different:
    // the figure anyone wants from it is the total off the rail, because that
    // is what sizes the battery and what the regulator has to hold up. Current
    // the chip sinks on a pin is deliberately not added — it comes off the rail
    // somewhere else and returns through gnd, so counting it at vcc would be
    // counting it twice.
    if (kind === "mcu") {
      const supply = voltageAt(solution, nodeOf(index, component, "vcc")) - voltageAt(solution, nodeOf(index, component, "gnd"));
      let total = Math.max(0, supply) * (Math.max(0, Number(values.activeAmps) || 0) / NOMINAL_LOGIC_VOLTS);
      for (const pin of DRIVEN_PINS.mcu) {
        const allocation = index.drivers.get(`${component.id}:${pin}`);
        if (!allocation) continue;
        total += Math.max(0, -solution[allocation.branch]);
      }
      currents.set(component.id, total);
      continue;
    }
    if (DRIVEN_PINS[kind]) {
      // The current a chip is sourcing out of its first driven output, which is
      // the figure that matters: whether it is within what the part can supply.
      const first = DRIVEN_PINS[kind].find((pin) => index.drivers.has(`${component.id}:${pin}`));
      currents.set(component.id, first ? -solution[index.drivers.get(`${component.id}:${first}`).branch] : 0);
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
    // A motor's current is not "voltage over resistance" once it is turning —
    // the back-EMF is in the way, and it is the whole reason a running motor
    // draws a fraction of what a stalled one does. Reading it off the winding
    // alone would report stall current forever.
    if (kind === "motor") {
      const past = moment?.devices?.get(component.id) || { speed: 0, current: 0 };
      if (!moment) {
        currents.set(component.id, across / Math.max(0.01, Number(values.resistance) || 3));
        continue;
      }
      const companion = motorCompanion(values, moment.dt, past);
      currents.set(component.id, (companion.conductance * across) + companion.source);
      continue;
    }
    if (kind === "buzzer") {
      currents.set(component.id, across / Math.max(1, Number(values.resistance) || 32));
      continue;
    }
    if (kind === "servo") {
      const supply = voltageAt(solution, nodeOf(index, component, "vcc")) - voltageAt(solution, nodeOf(index, component, "gnd"));
      currents.set(component.id, supply / 150);
      continue;
    }
    // A multi-LED package reports what the whole package is drawing, which is
    // the figure that matters against its rating and against what is driving it.
    if (kind === "rgbled" || kind === "sevenseg") {
      const commonNode = nodeOf(index, component, "common");
      const anodeCommon = String(values.common || "cathode") === "anode";
      let total = 0;
      for (const segment of PARTS[kind].pins) {
        if (segment === "common" || !component.pins[segment]) continue;
        const pinNode = nodeOf(index, component, segment);
        const drop = anodeCommon
          ? voltageAt(solution, commonNode) - voltageAt(solution, pinNode)
          : voltageAt(solution, pinNode) - voltageAt(solution, commonNode);
        const model = partModel("led", { colour: segment }) || partModel("led", {}) || {};
        const scale = (model.emission || 2) * 0.025852;
        total += (model.saturationCurrent || 1e-20) * (Math.exp(Math.min(80, drop / scale)) - 1);
      }
      currents.set(component.id, total);
      continue;
    }
    // A reactive part's current comes from its companion model, not from a
    // resistance it does not have. Reporting the DC approximation during a
    // transient run would say a charging capacitor passes nothing, which is the
    // opposite of what is happening.
    if (moment && (kind === "capacitor" || kind === "inductor")) {
      const past = moment.history.get(component.id) || { voltage: 0, current: 0 };
      const companion = kind === "capacitor"
        ? capacitorCompanion(Math.max(1e-15, Number(values.farads) || 0), moment.dt, past, moment.method)
        : inductorCompanion(Math.max(1e-12, Number(values.henries) || 0), moment.dt, past, moment.method);
      currents.set(component.id, (companion.conductance * across) + companion.source);
      continue;
    }
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
    const result = solveNonlinear(index.size, (system, current, circuit) => stampComponents(components, index, system, circuit));
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

export { formatOhms, currentsFor, voltageAt, nodeOf };
