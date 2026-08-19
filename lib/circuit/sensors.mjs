// The parts that turn something about the world into something electrical.
//
// Everything in the sandbox until now responded only to other parts. A sensor
// is the first thing whose behaviour comes from outside the circuit, and that
// makes it the piece a data-logging board is built around: without one, a
// telemetry board has nothing to log.
//
// Two of these are resistances that change (a thermistor, a light-dependent
// resistor) and two are chips that drive an output (a wheel sensor, an
// accelerometer). That split is not cosmetic — it is why one pair needs no
// supply and the other pair does, and it is the first thing to understand about
// wiring either of them.
//
// The figures are from the parts people actually buy: a 10k NTC with a beta of
// 3950, a GL5528 LDR, an A3144-style hall switch, an ADXL335. Where a datasheet
// gives a range, the typical value is used, for the reason parts.mjs gives.

import { conditionsAt, integrateCondition } from "./conditions.mjs";

// Absolute zero in the units the rest of the world uses.
const KELVIN = 273.15;
// Where a thermistor's quoted resistance is quoted: 25°C, always.
const NOMINAL_KELVIN = 25 + KELVIN;

export const SENSOR_KINDS = Object.freeze(["thermistor", "ldr", "hall", "accelerometer"]);

// Which pins a sensor drives, for the same reason netlist.mjs keeps that table
// for chips: each needs a branch unknown and an internal node behind its output
// resistance.
export const SENSOR_DRIVEN_PINS = Object.freeze({
  hall: ["out"],
  accelerometer: ["x", "y", "z"]
});

// A thermistor's resistance at a temperature, by the beta equation.
//
//   R = R₀ · exp(B · (1/T − 1/T₀))
//
// Which is the two-point fit every hobby part is sold with, and is good to
// about a degree over the range a bike or a room lives in. It is not the
// Steinhart–Hart cubic — that needs three coefficients nobody prints on the bag
// the part came in.
export function thermistorOhms(values = {}, celsius = 25) {
  const nominal = Math.max(1, Number(values.ohms) || 10_000);
  const beta = Math.max(1, Number(values.beta) || 3950);
  const kelvin = Math.max(1, Number(celsius) + KELVIN);
  const negative = String(values.coefficient || "ntc") !== "ptc";
  const exponent = beta * ((1 / kelvin) - (1 / NOMINAL_KELVIN));
  const ohms = nominal * Math.exp(negative ? exponent : -exponent);
  return Math.min(1e9, Math.max(1, ohms));
}

// A light-dependent resistor, by the power law its datasheet is drawn on.
//
//   R = R₁₀ · (10 / lux)^γ
//
// Quoted at 10 lux because that is where the common curves are pinned. In the
// dark it does not go to infinity, it goes to the dark resistance on the
// datasheet — a megohm for a GL5528 — and saying so matters, because a divider
// built with one has a defined output in the dark rather than a floating pin.
export function ldrOhms(values = {}, lux = 200) {
  const atTenLux = Math.max(1, Number(values.ohms) || 10_000);
  const gamma = Math.max(0.1, Number(values.gamma) || 0.8);
  const dark = Math.max(atTenLux, Number(values.darkOhms) || 1_000_000);
  const light = Math.max(0, Number(lux) || 0);
  if (light < 1e-3) return dark;
  return Math.min(dark, Math.max(1, atTenLux * Math.pow(10 / light, gamma)));
}

// How often a wheel sensor sees a magnet, in Hz.
//
// Road speed divided by how far one turn of the wheel covers, times how many
// magnets are on it. The default circumference is 2096mm, which is the number
// bike computers ship set to and is a 700×23c tyre.
export function wheelPulseHz(values = {}, kilometresPerHour = 0) {
  const circumference = Math.max(0.05, Number(values.circumference) || 2.096);
  const magnets = Math.max(1, Math.round(Number(values.magnets) || 1));
  const metresPerSecond = (Math.max(0, Number(kilometresPerHour) || 0) * 1000) / 3600;
  return (metresPerSecond / circumference) * magnets;
}

// How many magnets have gone past, given how far the bike has travelled.
//
// `kilometreHours` is the integral of speed in km/h over seconds, which is what
// integrateCondition returns — so the same 1000/3600 that turns km/h into m/s
// turns it into metres here.
export function wheelPhase(values = {}, kilometreHours = 0) {
  const circumference = Math.max(0.05, Number(values.circumference) || 2.096);
  const magnets = Math.max(1, Math.round(Number(values.magnets) || 1));
  const metres = (Math.max(0, kilometreHours) * 1000) / 3600;
  return (metres / circumference) * magnets;
}

// And the speed a given pulse rate means, which is the arithmetic the firmware
// on the board has to do. Here so that a test can check the board got it right
// without repeating the sum it is checking.
export function speedFromPulseHz(values = {}, hertz = 0) {
  const circumference = Math.max(0.05, Number(values.circumference) || 2.096);
  const magnets = Math.max(1, Math.round(Number(values.magnets) || 1));
  return ((Math.max(0, hertz) / magnets) * circumference * 3600) / 1000;
}

// What a sensor is driving its output to, in the same shape chips.mjs uses:
// `volts` is the drop from `reference`, so an output driving towards the supply
// takes its current off the supply.
export function sensorDriver(component, read, conditions, time = 0) {
  const values = component.values || {};
  const world = conditionsAt(conditions, time);
  const supply = read("vcc") - read("gnd");
  // Below a volt there is no chip, only a part with legs. Returning nothing
  // leaves the pin stamped as an open circuit, which is what an unpowered
  // sensor is.
  if (supply < 1) return null;

  switch (component.kind) {
    case "hall": {
      const hertz = wheelPulseHz(values, world.speed);
      // Present for a slice of each turn rather than half of it: a magnet is a
      // small thing going past a small thing, and a sensor that read 50% duty
      // would make a scope trace look nothing like the real one.
      const duty = Math.min(0.9, Math.max(0.01, Number(values.duty) || 0.1));
      // Where the wheel actually is, from how far it has travelled — not from
      // the speed it happens to be doing now multiplied by the clock.
      //
      // Those are the same thing only at a constant speed. Accelerating from
      // rest, the second counts every turn as though the whole ride had been at
      // the current speed, and a board counting pulses reads a distance
      // twice what it rode. Phase is the integral of frequency; there is no
      // shortcut that survives the speed changing, which is the case this whole
      // stage exists to make possible.
      const detected = hertz > 0 && (wheelPhase(values, integrateCondition(conditions, "speed", time)) % 1) < duty;
      // Active low, which is what these parts do — the output pulls down while
      // a magnet is there. A board that expects a pulse high sees nothing, and
      // that is a real afternoon lost, so the model does not smooth it over.
      const open = String(values.style || "push-pull") === "open-drain";
      if (detected) return { volts: HALL_SATURATION, reference: "gnd", resistance: HALL_ON_OHMS, detected, hertz };
      // An open-drain output that is not pulling down is not driving anything;
      // it is waiting for a pull-up resistor that the board has to provide.
      if (open) return { volts: 0, reference: "gnd", resistance: 1e9, detected, hertz };
      return { volts: -HALL_SATURATION, reference: "vcc", resistance: HALL_ON_OHMS, detected, hertz };
    }

    case "accelerometer": {
      // Ratiometric, as these parts are: zero g sits at half the supply and the
      // sensitivity scales with it too. That is why one reads differently on
      // 3.3V and 5V rails unless the ADC's reference moves with it, which is
      // the classic reason a reading drifts when the battery sags.
      const range = Math.max(0.5, Number(values.range) || 3);
      const perG = supply * (Number(values.sensitivityFraction) || 0.1);
      const axes = { x: world.accelX, y: world.accelY, z: world.accelZ };
      const level = {};
      const clipped = {};
      for (const [axis, force] of Object.entries(axes)) {
        const held = Math.min(range, Math.max(-range, Number(force) || 0));
        clipped[axis] = Math.abs(Number(force) || 0) > range;
        // Referenced to the supply rail, so the current comes off it, and
        // clamped inside the rails because no output gets past them.
        level[axis] = Math.min(0, Math.max(-supply, ((supply / 2) + (held * perG)) - supply));
      }
      return {
        volts: level.x,
        reference: "vcc",
        resistance: ACCELEROMETER_OUT_OHMS,
        pins: level,
        references: { x: "vcc", y: "vcc", z: "vcc" },
        clipped: Object.entries(clipped).filter(([, was]) => was).map(([axis]) => axis)
      };
    }

    default:
      return null;
  }
}

// A saturated bipolar output does not reach the rail, and the 0.4V it stops
// short by is the reason a hall sensor into a logic input is fine and into
// another supply rail is not.
const HALL_SATURATION = 0.4;
const HALL_ON_OHMS = 40;
// An ADXL335 is a few tens of kilohms out, which is why its datasheet insists
// on a capacitor at the pin and why a low-impedance load flattens the reading.
const ACCELEROMETER_OUT_OHMS = 32_000;

// The resistance a passive sensor is presenting right now.
export function sensorOhms(component, world) {
  if (component.kind === "thermistor") return thermistorOhms(component.values, world.temperature);
  if (component.kind === "ldr") return ldrOhms(component.values, world.light);
  return null;
}

// What a sensor is reading, for the schematic and for a model asking what it
// can see. The reading, not the voltage it produced — those are different
// claims, and the whole point of a sensor is the first one.
export function sensorView(component, conditions, time = 0) {
  const world = conditionsAt(conditions, time);
  const values = component.values || {};
  switch (component.kind) {
    case "thermistor":
      return { reading: `${round(world.temperature, 1)}°C`, ohms: thermistorOhms(values, world.temperature), celsius: world.temperature };
    case "ldr":
      return { reading: `${round(world.light, 0)} lux`, ohms: ldrOhms(values, world.light), lux: world.light };
    case "hall": {
      const hertz = wheelPulseHz(values, world.speed);
      return {
        reading: hertz > 0 ? `${round(world.speed, 1)}km/h · ${round(hertz, 2)}Hz` : "stopped",
        hertz, speed: world.speed,
        // What the firmware should work out from those pulses, so the number on
        // screen and the number the board prints can be compared directly.
        impliedSpeed: speedFromPulseHz(values, hertz)
      };
    }
    case "accelerometer": {
      const total = Math.hypot(world.accelX, world.accelY, world.accelZ);
      return {
        reading: `${round(world.accelX, 2)}, ${round(world.accelY, 2)}, ${round(world.accelZ, 2)}g`,
        x: world.accelX, y: world.accelY, z: world.accelZ, magnitude: total
      };
    }
    default:
      return null;
  }
}

const round = (value, places) => {
  const scale = 10 ** places;
  return Math.round((Number(value) || 0) * scale) / scale;
};
