// Real parts, with the numbers printed on their datasheets.
//
// The point of this sandbox is a circuit you could build on a bench, so the
// catalogue is specific parts rather than ideal elements: a 1N4148 rather than
// "a diode", a red LED that drops 2.0V rather than one that drops whatever the
// maths prefers. Every entry carries its ratings, because "this part burns out"
// is the check that makes the difference between a simulation and a drawing.
//
// Values are typical, at room temperature, from the common datasheets. They are
// not binned minimums or worst-case maximums — a circuit that only works with
// typical values is a circuit that works on most benches and fails on some, and
// this sandbox is not the place to teach statistical design.

// Saturation current and emission coefficient are what the solver's exponential
// needs. They are fitted so the part sits at its published forward voltage at
// its normal operating current, which is the number anyone would check.
const RED_LED = { saturationCurrent: 1e-20, emission: 2, forward: 2.0 };
const GREEN_LED = { saturationCurrent: 1e-21, emission: 2.1, forward: 2.2 };
const YELLOW_LED = { saturationCurrent: 5e-21, emission: 2, forward: 2.1 };
const BLUE_LED = { saturationCurrent: 1e-24, emission: 2.5, forward: 3.2 };
const WHITE_LED = { saturationCurrent: 1e-24, emission: 2.5, forward: 3.2 };

// The E12 series: the resistor values that actually exist in a drawer.
//
// A model asked for "a 3.7k resistor" should be told the nearest real one is
// 3.9k, not handed a part nobody sells. This is the list every hobby kit ships.
// A source that changes over time, said the way a person would say it.
//
// Kept to three shapes rather than SPICE's seven-parameter PULSE. A model
// choosing between "dc", "sine" and "pulse" with a frequency will get it right;
// one choosing rise and fall times in nanoseconds mostly will not, and none of
// the extra parameters teach anything this sandbox is for.
export function describeSource(values = {}) {
  const waveform = values.waveform || "dc";
  if (waveform === "sine") return `${values.amplitude}V ${formatFrequency(values.frequency)} sine on ${values.volts}V`;
  if (waveform === "pulse") return `${values.low}–${values.volts}V ${formatFrequency(values.frequency)} pulse`;
  return `${values.volts}V supply`;
}

export function formatFrequency(value) {
  const hertz = Number(value);
  if (!Number.isFinite(hertz)) return "?";
  if (hertz >= 1e6) return `${trim(hertz / 1e6)}MHz`;
  if (hertz >= 1e3) return `${trim(hertz / 1e3)}kHz`;
  return `${trim(hertz)}Hz`;
}

// What a source is putting out at this instant.
export function sourceVoltage(values = {}, time = 0) {
  const base = Number(values.volts) || 0;
  const waveform = values.waveform || "dc";
  if (waveform === "sine") {
    const amplitude = Number(values.amplitude) || 0;
    const frequency = Number(values.frequency) || 0;
    return base + (amplitude * Math.sin(2 * Math.PI * frequency * time));
  }
  if (waveform === "pulse") {
    const frequency = Number(values.frequency) || 0;
    if (frequency <= 0) return base;
    const duty = Math.min(1, Math.max(0, Number(values.duty ?? 0.5)));
    const phase = (time * frequency) % 1;
    return phase < duty ? base : (Number(values.low) || 0);
  }
  return base;
}

export function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "?";
  const size = Math.abs(seconds);
  if (size === 0) return "0s";
  if (size < 1e-6) return `${trim(seconds * 1e9)}ns`;
  if (size < 1e-3) return `${trim(seconds * 1e6)}µs`;
  if (size < 1) return `${trim(seconds * 1e3)}ms`;
  return `${trim(seconds)}s`;
}

export const E12 = Object.freeze([1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]);

export function nearestE12(ohms) {
  const value = Number(ohms);
  if (!Number.isFinite(value) || value <= 0) return null;
  const decade = Math.floor(Math.log10(value));
  let best = null;
  // Neighbouring decades too: 9.5k is nearer 10k than 8.2k.
  for (const power of [decade - 1, decade, decade + 1]) {
    for (const step of E12) {
      const candidate = step * (10 ** power);
      if (best === null || Math.abs(Math.log(candidate / value)) < Math.abs(Math.log(best / value))) best = candidate;
    }
  }
  return Number(best.toPrecision(3));
}

// Pins are named, not numbered, because a model writing "the anode" is far less
// likely to be wrong than one writing "pin 1". The order here is the order a
// symbol draws them.
export const PARTS = Object.freeze({
  resistor: {
    label: "Resistor", symbol: "resistor", pins: ["a", "b"], unit: "Ω",
    defaults: { ohms: 1_000, watts: 0.25 },
    ratings: { watts: 0.25 },
    describe: (values) => `${formatOhms(values.ohms)} resistor`
  },
  capacitor: {
    label: "Capacitor", symbol: "capacitor", pins: ["a", "b"], unit: "F",
    defaults: { farads: 1e-7, volts: 50 },
    ratings: { volts: 50 },
    describe: (values) => `${formatFarads(values.farads)} capacitor`
  },
  inductor: {
    label: "Inductor", symbol: "inductor", pins: ["a", "b"], unit: "H",
    defaults: { henries: 1e-3, amps: 1 },
    ratings: { amps: 1 },
    describe: (values) => `${formatHenries(values.henries)} inductor`
  },
  // A battery and a supply are the same element; they differ in what a person
  // pictures, and the symbol reflects that.
  // Both sources carry an internal resistance, and it is not decoration.
  //
  // No real source can deliver unlimited current. An ideal one can, and an ideal
  // 5V across an LED with no series resistor asks the solver for something like
  // 10^42 amps — which does not merely give a silly answer, it makes the matrix
  // numerically degenerate and the whole circuit reports "no single answer".
  // That is the single most common beginner mistake in electronics, and
  // answering it with a matrix complaint instead of "your LED is passing 50A and
  // is rated for 20mA" would miss the entire point of this sandbox.
  //
  // The figures are ordinary: a PP3 battery is a couple of ohms, a bench supply
  // or a USB rail is a few tens of milliohms.
  battery: {
    label: "Battery", symbol: "battery", pins: ["positive", "negative"], unit: "V",
    defaults: { volts: 9, resistance: 1.5, waveform: "dc", amplitude: 1, frequency: 1_000, duty: 0.5, low: 0 },
    ratings: {},
    describe: (values) => `${values.volts}V battery`
  },
  supply: {
    label: "Power supply", symbol: "supply", pins: ["positive", "negative"], unit: "V",
    defaults: { volts: 5, resistance: 0.05, waveform: "dc", amplitude: 1, frequency: 1_000, duty: 0.5, low: 0 },
    ratings: {},
    describe: (values) => describeSource(values)
  },
  ground: {
    label: "Ground", symbol: "ground", pins: ["pin"], unit: "",
    defaults: {}, ratings: {},
    describe: () => "ground"
  },
  diode: {
    label: "Diode", symbol: "diode", pins: ["anode", "cathode"], unit: "",
    defaults: { part: "1N4148" },
    ratings: { amps: 0.2, reverseVolts: 75 },
    models: {
      "1N4148": { saturationCurrent: 1e-14, emission: 1, ratings: { amps: 0.2, reverseVolts: 75 } },
      "1N4007": { saturationCurrent: 5e-9, emission: 1.8, ratings: { amps: 1, reverseVolts: 1_000 } },
      "1N5819": { saturationCurrent: 1e-7, emission: 1.1, ratings: { amps: 1, reverseVolts: 40 } }
    },
    describe: (values) => `${values.part || "1N4148"} diode`
  },
  led: {
    label: "LED", symbol: "led", pins: ["anode", "cathode"], unit: "",
    defaults: { colour: "red" },
    // 20mA is the absolute maximum on almost every 5mm indicator LED; 30mA is
    // where it dies quickly. The check warns at the rating, not at destruction.
    ratings: { amps: 0.02 },
    models: {
      red: RED_LED, green: GREEN_LED, yellow: YELLOW_LED, blue: BLUE_LED, white: WHITE_LED
    },
    describe: (values) => `${values.colour || "red"} LED`
  },
  switch: {
    label: "Switch", symbol: "switch", pins: ["a", "b"], unit: "",
    defaults: { closed: false },
    ratings: { amps: 0.5 },
    describe: (values) => `switch (${values.closed ? "closed" : "open"})`
  },
  potentiometer: {
    label: "Potentiometer", symbol: "potentiometer", pins: ["a", "wiper", "b"], unit: "Ω",
    defaults: { ohms: 10_000, position: 0.5, watts: 0.25 },
    ratings: { watts: 0.25 },
    describe: (values) => `${formatOhms(values.ohms)} potentiometer at ${Math.round((values.position ?? 0.5) * 100)}%`
  }
});

// A resistor reads 4.7k, not 4700, and certainly not 4.7e3. Everything a person
// sees goes through here so the sandbox and the bill of materials agree.
export function formatOhms(value) {
  const ohms = Number(value);
  if (!Number.isFinite(ohms)) return "?";
  if (ohms >= 1e6) return `${trim(ohms / 1e6)}MΩ`;
  if (ohms >= 1e3) return `${trim(ohms / 1e3)}kΩ`;
  return `${trim(ohms)}Ω`;
}

export function formatFarads(value) {
  const farads = Number(value);
  if (!Number.isFinite(farads)) return "?";
  if (farads >= 1e-3) return `${trim(farads * 1e3)}mF`;
  if (farads >= 1e-6) return `${trim(farads * 1e6)}µF`;
  if (farads >= 1e-9) return `${trim(farads * 1e9)}nF`;
  return `${trim(farads * 1e12)}pF`;
}

export function formatHenries(value) {
  const henries = Number(value);
  if (!Number.isFinite(henries)) return "?";
  if (henries >= 1) return `${trim(henries)}H`;
  if (henries >= 1e-3) return `${trim(henries * 1e3)}mH`;
  return `${trim(henries * 1e6)}µH`;
}

export function formatVolts(value) {
  const volts = Number(value);
  if (!Number.isFinite(volts)) return "?";
  if (Math.abs(volts) < 0.1 && volts !== 0) return `${trim(volts * 1e3)}mV`;
  return `${trim(volts)}V`;
}

export function formatAmps(value) {
  const amps = Number(value);
  if (!Number.isFinite(amps)) return "?";
  const magnitude = Math.abs(amps);
  if (magnitude === 0) return "0A";
  if (magnitude < 1e-6) return `${trim(amps * 1e9)}nA`;
  if (magnitude < 1e-3) return `${trim(amps * 1e6)}µA`;
  if (magnitude < 1) return `${trim(amps * 1e3)}mA`;
  return `${trim(amps)}A`;
}

function trim(value) {
  // Three significant figures, without a trailing ".00" on a round number.
  const rounded = Number(Number(value).toPrecision(3));
  return String(rounded);
}

export const PART_KINDS = Object.freeze(Object.keys(PARTS));

// The model for a specific part, or the kind's default.
export function partModel(kind, values = {}) {
  const definition = PARTS[kind];
  if (!definition) return null;
  const key = values.part || values.colour;
  return definition.models?.[key] || definition.models?.[definition.defaults.part || definition.defaults.colour] || null;
}

// Ratings for a specific part rather than for its kind: a 1N4007 takes an amp
// where a 1N4148 takes 200mA, and warning at the wrong one is worse than not
// warning at all.
export function partRatings(kind, values = {}) {
  const definition = PARTS[kind];
  if (!definition) return {};
  const model = partModel(kind, values);
  return {
    ...definition.ratings,
    ...(model?.ratings || {}),
    // A resistor's wattage and a capacitor's voltage are chosen per part, so an
    // explicit value on the component wins over the kind's default.
    ...(Number.isFinite(values.watts) ? { watts: values.watts } : {}),
    ...(Number.isFinite(values.volts) && kind === "capacitor" ? { volts: values.volts } : {})
  };
}
