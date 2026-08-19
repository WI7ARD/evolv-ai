// The parts that decide something rather than just conduct.
//
// An op-amp, a logic gate, a 555 and a voltage regulator look nothing alike on a
// schematic and are the same thing to a solver: each reads some of its pins and
// drives its output to a voltage, through an output resistance that is never
// zero. Writing that once means a 74HC gate driving an LED through a resistor
// gets the current right for the same reason an op-amp driving a load does,
// rather than for a reason someone had to remember twice.
//
// Every model here is a macromodel — the behaviour off the datasheet's front
// page, not the transistors inside. That is the right altitude for a sandbox
// about building things: it gets output swing, dropout and drive strength right,
// which is what bites people, and says nothing about slew rate or input offset,
// which mostly does not.

import { formatVolts } from "./parts.mjs";

// What a real part can actually pull its output to. None of these reach their
// own rails, and the gap is why a 74HC output feeding a 5V comparator sometimes
// does not register — a fact worth having in the model rather than in a footnote.
const OPAMP_HEADROOM = 1.5;      // A 741-era part loses this much at each rail.
const CMOS_HEADROOM = 0.05;      // A 74HC output gets much closer.

export const CHIP_MODELS = Object.freeze({
  opamp: {
    LM358: { gain: 100_000, outputResistance: 75, headroom: 1.5, railToRail: false },
    LM741: { gain: 200_000, outputResistance: 75, headroom: 2.0, railToRail: false },
    MCP6002: { gain: 112_000, outputResistance: 100, headroom: 0.025, railToRail: true }
  },
  regulator: {
    LM7805: { volts: 5, dropout: 2.0, resistance: 0.05, maxAmps: 1 },
    LM7812: { volts: 12, dropout: 2.0, resistance: 0.05, maxAmps: 1 },
    LM317: { volts: 5, dropout: 3.0, resistance: 0.05, maxAmps: 1.5 },
    AMS1117: { volts: 3.3, dropout: 1.1, resistance: 0.05, maxAmps: 0.8 }
  },
  // 74HC at 5V: an output source/sink resistance of about 25Ω, inputs switching
  // near half the supply.
  logic: { outputResistance: 25, headroom: CMOS_HEADROOM }
});

export const GATE_FUNCTIONS = Object.freeze(["and", "or", "nand", "nor", "xor", "xnor", "not", "buffer"]);

function high(value, supply) {
  // A CMOS input is undefined between about 30% and 70% of the supply. Treating
  // the midpoint as the boundary is the standard simplification and it is what
  // makes a floating input read as *something* rather than as an error — which
  // is itself a lie a real floating input tells.
  return value > supply / 2;
}

export function gateOutput(fn, inputs) {
  const [a, b] = inputs;
  switch (fn) {
    case "and": return a && b;
    case "or": return a || b;
    case "nand": return !(a && b);
    case "nor": return !(a || b);
    case "xor": return a !== b;
    case "xnor": return a === b;
    case "not": return !a;
    case "buffer": return a;
    default: return false;
  }
}

// What a chip is driving its output to, given what it can currently see.
//
// `read(pin)` returns the voltage at a pin. `state` is the part's own memory
// between timesteps — a flip-flop's Q, a 555's latch — and is absent at a DC
// operating point, where a part is asked what it settles to rather than what it
// does next.
//
// Returns `{ volts, resistance }` for a part driving one output, plus a `pins`
// map when it drives several, or null when it is driving nothing at all.
//
// This function is pure. It reads state and never writes it, because it is
// called once per Newton iteration and a latch that updated inside the solve
// would consume its own clock edge on the first iteration and hold a different
// value for the rest — the answer depending on how many iterations convergence
// happened to take. Latches advance once per timestep, in advanceChips below.
export function chipDriver(component, read, state = null) {
  const values = component.values || {};
  switch (component.kind) {
    case "opamp": {
      const model = CHIP_MODELS.opamp[values.part] || CHIP_MODELS.opamp.LM358;
      const positiveRail = read("vPos");
      const negativeRail = read("vNeg");
      const difference = read("inPlus") - read("inMinus");
      const headroom = model.headroom;
      const ideal = model.gain * difference;
      // Clipping, not a fantasy voltage. An op-amp asked for 40V on a 12V rail
      // gives 10.5V and that is the whole lesson of the first op-amp circuit
      // anyone builds wrong.
      const ceiling = positiveRail - headroom;
      const floor = negativeRail + headroom;
      // Before the first solve every node reads zero, so the rails read zero
      // too and the headroom inverts — the floor ends up above the ceiling and
      // the part declares itself clipped before anything has been computed.
      // From there it alternated between clipped and linear and never settled.
      // A supply that has not been solved yet is not evidence of clipping.
      if (!(ceiling > floor)) {
        return { volts: 0, resistance: model.outputResistance, saturated: false };
      }
      return {
        volts: Math.min(ceiling, Math.max(floor, ideal)),
        resistance: model.outputResistance,
        saturated: ideal > ceiling || ideal < floor
      };
    }

    case "regulator": {
      const model = CHIP_MODELS.regulator[values.part] || CHIP_MODELS.regulator.LM7805;
      const input = read("input") - read("ground");
      const wanted = Number(values.volts) || model.volts;
      // Below dropout a regulator does not hold its output — it follows the
      // input down, minus the dropout. A model that kept promising 5V from a
      // 4V input would hide the single most common reason a regulated circuit
      // misbehaves.
      const available = input - model.dropout;
      return {
        volts: Math.max(0, Math.min(wanted, available)),
        resistance: model.resistance,
        reference: "ground",
        droppedOut: available < wanted
      };
    }

    case "gate": {
      const supply = read("vcc") - read("gnd");
      if (supply < 1) return null;
      const fn = GATE_FUNCTIONS.includes(values.function) ? values.function : "nand";
      const inputs = [high(read("a") - read("gnd"), supply), high(read("b") - read("gnd"), supply)];
      const output = gateOutput(fn, inputs);
      // Driving high is a switch closed to Vcc, so the source sits on Vcc and
      // drops the headroom; driving low is a switch closed to ground. Stated
      // this way the current a gate supplies is taken off the rail it came
      // from, which is both where it really comes from and the only way the
      // supply's own reading adds up.
      return {
        volts: output ? -CHIP_MODELS.logic.headroom : CHIP_MODELS.logic.headroom,
        resistance: CHIP_MODELS.logic.outputResistance,
        reference: output ? "vcc" : "gnd",
        logic: output
      };
    }

    case "flipflop": {
      const supply = read("vcc") - read("gnd");
      if (supply < 1) return null;
      // A D-type latches on the rising edge of its clock, which means it needs
      // to remember the clock it saw last. At a DC operating point there is no
      // "last", so it reports whatever it is holding and never latches — an
      // operating point is by definition the state where nothing is changing.
      const q = state?.q ?? false;
      const top = -CHIP_MODELS.logic.headroom;
      const bottom = CHIP_MODELS.logic.headroom;
      return {
        volts: q ? top : bottom,
        resistance: CHIP_MODELS.logic.outputResistance,
        reference: q ? "vcc" : "gnd",
        logic: q,
        // Both outputs, given explicitly. The first version derived Q-bar from
        // an "inverted" flag and got it backwards, so a D-type wired to its own
        // Q-bar — the standard divide-by-two — never toggled at all.
        //
        // Q and Q-bar are never on the same rail, so they need a reference
        // each: whichever one is high draws from Vcc while the other sinks to
        // ground.
        pins: { q: q ? top : bottom, qn: q ? bottom : top },
        references: { q: q ? "vcc" : "gnd", qn: q ? "gnd" : "vcc" }
      };
    }

    case "timer555": {
      const supply = read("vcc") - read("gnd");
      if (supply < 1) return null;
      // The 555 is two comparators and a latch. Control voltage sets the upper
      // threshold; left unconnected it sits at two thirds of the supply, which
      // is where the familiar 1.44/((R1+2·R2)·C) comes from.
      const control = Number.isFinite(values.control) ? values.control : (2 / 3) * supply;
      const upper = control;
      const lower = control / 2;

      const set = state?.set ?? false;
      return {
        volts: set ? -1.7 : 0.25,   // A bipolar 555 loses well over a volt at the top.
        resistance: 10,
        reference: set ? "vcc" : "gnd",
        logic: set,
        // Discharge is an open collector: a path to ground when the latch is
        // reset, and nothing at all when it is set. That is what makes the
        // capacitor charge and discharge through different resistors.
        discharge: set ? null : 20
      };
    }

    // A header pin whose behaviour is declared rather than programmed. Stage 5
    // replaces the declaration with firmware; until then this is how a circuit
    // gets a signal from "the microcontroller" without pretending to run one.
    case "mcupin": {
      const supply = read("vcc") - read("gnd");
      const mode = values.mode || "low";
      if (mode === "float" || mode === "input") return null;
      if (mode === "pwm") {
        // Averaged, not switched. Without a time base this is the honest
        // reading: a 50% duty pin drives half the supply on a meter, which is
        // exactly what a meter shows. Stage 5 makes it a real square wave.
        const duty = Math.min(1, Math.max(0, Number(values.duty ?? 0.5)));
        return { volts: supply * duty, resistance: 25, reference: "gnd", averaged: true };
      }
      return {
        volts: mode === "high" ? -CMOS_HEADROOM : CMOS_HEADROOM,
        resistance: 25,
        reference: mode === "high" ? "vcc" : "gnd",
        logic: mode === "high"
      };
    }

    default:
      return null;
  }
}

// Fresh memory for the parts that have any.
// Advance every latching part by one timestep.
//
// Called once per step, before the solve, reading the circuit as it stood at the
// end of the previous step. Keeping this out of the Newton loop is what makes a
// run reproducible: the latch state is fixed for the whole solve, so the answer
// does not depend on how many iterations convergence happened to need.
export function advanceChips(components, read, state) {
  if (!state) return;
  for (const component of components) {
    const memory = state.get(component.id);
    if (!memory) continue;
    const pin = (name) => read(component, name);
    const supply = pin("vcc") - pin("gnd");
    if (supply < 1) continue;

    if (component.kind === "flipflop") {
      const clock = high(pin("clk") - pin("gnd"), supply);
      if (clock && !memory.clock) memory.q = high(pin("d") - pin("gnd"), supply);
      memory.clock = clock;
      continue;
    }

    if (component.kind === "timer555") {
      const values = component.values || {};
      const control = Number.isFinite(values.control) ? values.control : (2 / 3) * supply;
      const threshold = pin("threshold") - pin("gnd");
      const trigger = pin("trigger") - pin("gnd");
      const resetPin = component.pins?.reset;
      const reset = pin("reset") - pin("gnd");
      if (resetPin && reset < supply * 0.3) {
        memory.set = false;
        continue;
      }
      // Threshold first, then trigger, because trigger wins in the real part.
      if (threshold > control) memory.set = false;
      if (trigger < control / 2) memory.set = true;
    }
  }
}

export function createChipState(components) {
  const state = new Map();
  for (const component of components) {
    if (component.kind === "flipflop") state.set(component.id, { q: false, clock: false });
    if (component.kind === "timer555") state.set(component.id, { set: false });
  }
  return state;
}

export function describeChip(kind, values = {}) {
  switch (kind) {
    case "opamp": return `${values.part || "LM358"} op-amp`;
    case "regulator": return `${values.part || "LM7805"} regulator`;
    case "gate": return `74HC ${String(values.function || "nand").toUpperCase()} gate`;
    case "flipflop": return "74HC D flip-flop";
    case "timer555": return "NE555 timer";
    case "mcupin": return `MCU pin (${values.mode || "low"}${values.mode === "pwm" ? ` ${Math.round((values.duty ?? 0.5) * 100)}%` : ""})`;
    default: return kind;
  }
}

export { formatVolts };
