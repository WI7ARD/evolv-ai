// A microcontroller, deliberately not pretending to be a real one.
//
// It has digital pins, analog inputs, PWM outputs, a clock speed and a timer.
// It is not an Arduino Uno, and that is the point: everything a specific board
// does that this does not would become a wrong claim about a part somebody owns
// and can test. A generic chip can only be incomplete, never wrong.
//
// The pins are real nodes in the circuit. An output drives its net through a
// real output resistance, an input reads the voltage that is actually there,
// and a pull-up is a real resistor — so a floating input reads what a floating
// input reads, and a pin driving too much current shows up in the findings like
// anything else.

import { Firmware, FirmwareError } from "./firmware.mjs";

export const MCU_DIGITAL_PINS = 8;
export const MCU_ANALOG_PINS = 4;
export const DEFAULT_CLOCK_HZ = 16_000_000;
// A 74HC-class output: about 25Ω, and it does not quite reach either rail.
const OUTPUT_RESISTANCE = 25;
const OUTPUT_HEADROOM = 0.05;
const PULLUP_OHMS = 20_000;
// Arduino's default PWM rate. Slow enough to see on a trace, fast enough that
// an LED looks steady.
export const PWM_HZ = 490;
const ADC_STEPS = 1024;

export const PIN_MODES = Object.freeze({ INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2 });

export function mcuPinNames() {
  return [
    ...Array.from({ length: MCU_DIGITAL_PINS }, (unused, index) => `d${index}`),
    ...Array.from({ length: MCU_ANALOG_PINS }, (unused, index) => `a${index}`)
  ];
}

// Pin numbers as firmware sees them: 0..7 are the digital pins, and the analog
// ones carry on from there, so analogRead(0) and pin 8 are the same leg.
export function pinName(number) {
  const index = Math.round(Number(number));
  if (!Number.isFinite(index) || index < 0) return "";
  if (index < MCU_DIGITAL_PINS) return `d${index}`;
  if (index < MCU_DIGITAL_PINS + MCU_ANALOG_PINS) return `a${index - MCU_DIGITAL_PINS}`;
  return "";
}

export class Mcu {
  constructor(component, { clockHz = DEFAULT_CLOCK_HZ } = {}) {
    this.id = component.id;
    this.clockHz = Math.max(1_000, Number(component.values?.clockHz) || clockHz);
    this.micros = 0;
    this.pins = new Map();
    for (const name of mcuPinNames()) {
      this.pins.set(name, { mode: PIN_MODES.INPUT, value: 0, duty: null, voltage: 0 });
    }
    this.supply = 5;
    this.observed = false;
    this.firmware = null;
    this.error = null;
    // Set when the firmware spends its whole budget for a long stretch without
    // finishing an iteration of loop(). That is a hung program, and on a real
    // board it is the one that looks like nothing is happening at all.
    this.starvedSteps = 0;
  }

  load(source) {
    this.error = null;
    try {
      this.firmware = new Firmware(source, this.#host());
    } catch (error) {
      this.firmware = null;
      this.error = error instanceof FirmwareError ? error : new FirmwareError(error.message);
      throw this.error;
    }
    return { loaded: true };
  }

  // Everything the firmware can reach. This object is the entire surface: a
  // program can call these and nothing else, because the interpreter resolves
  // no other names.
  #host() {
    return {
      pinMode: (number, mode) => {
        const pin = this.pins.get(pinName(number));
        if (!pin) return;
        pin.mode = Number(mode) === PIN_MODES.OUTPUT ? PIN_MODES.OUTPUT
          : Number(mode) === PIN_MODES.INPUT_PULLUP ? PIN_MODES.INPUT_PULLUP
            : PIN_MODES.INPUT;
        if (pin.mode !== PIN_MODES.OUTPUT) pin.duty = null;
      },
      digitalWrite: (number, value) => {
        const pin = this.pins.get(pinName(number));
        if (!pin) return;
        pin.value = value ? 1 : 0;
        pin.duty = null;
      },
      digitalRead: (number) => {
        const pin = this.pins.get(pinName(number));
        if (!pin) return 0;
        // What is actually on the leg, not what the firmware last wrote there.
        // A pin set high but shorted to ground reads low, which is how you find
        // a short with a print statement.
        return pin.voltage > this.supply / 2 ? 1 : 0;
      },
      analogWrite: (number, value) => {
        const pin = this.pins.get(pinName(number));
        if (!pin) return;
        pin.mode = PIN_MODES.OUTPUT;
        pin.duty = Math.min(1, Math.max(0, Number(value) / 255));
      },
      analogRead: (number) => {
        const pin = this.pins.get(pinName(number));
        if (!pin) return 0;
        // Ten bits, quantised, because the quantisation is real and someone
        // wondering why their reading jitters between 512 and 513 deserves to
        // meet it here rather than on a bench.
        const fraction = Math.min(1, Math.max(0, pin.voltage / Math.max(0.001, this.supply)));
        return Math.round(fraction * (ADC_STEPS - 1));
      },
      millis: () => Math.floor(this.micros / 1000),
      micros: () => this.micros
    };
  }

  // What each pin is driving, for the solver to stamp.
  drive() {
    const driven = {};
    for (const [name, pin] of this.pins) {
      if (pin.mode === PIN_MODES.OUTPUT) {
        const high = pin.duty === null
          ? pin.value === 1
          // Software has no idea a PWM pin is switching; the hardware does it.
          // Working it out from the time inside the current period is what makes
          // analogWrite produce a real square wave rather than an average.
          : ((this.micros / 1e6) * PWM_HZ) % 1 < pin.duty;
        // `reference` says which of the chip's own supply legs this pin hangs
        // off, and `volts` is the drop from there to the pin. A push-pull output
        // driving high is a switch closed to Vcc, so its current comes off Vcc;
        // said as an absolute voltage against ground instead, a pin lighting an
        // LED conjured the current from nowhere and the supply reported
        // delivering none of it.
        driven[name] = {
          volts: high ? -OUTPUT_HEADROOM : OUTPUT_HEADROOM,
          reference: high ? "vcc" : "gnd",
          resistance: OUTPUT_RESISTANCE
        };
        continue;
      }
      if (pin.mode === PIN_MODES.INPUT_PULLUP) {
        driven[name] = { volts: 0, reference: "vcc", resistance: PULLUP_OHMS };
        continue;
      }
      // An input is high impedance. Not nothing — nothing would leave the node
      // with no path at all and the matrix with no answer.
      driven[name] = { volts: 0, reference: "gnd", resistance: 1e9 };
    }
    return driven;
  }

  // Read the solved circuit back into the pins, so digitalRead and analogRead
  // answer about the world rather than about what the firmware believes.
  observe(read) {
    // Whether this chip has ever seen a solved circuit. A run seeds this from a
    // bias solve before the firmware's first instruction, so the flag says
    // "the rails are up" rather than counting anything.
    this.observed = true;
    const ground = read("gnd");
    this.supply = Math.max(0.001, read("vcc") - ground);
    for (const [name, pin] of this.pins) pin.voltage = read(name) - ground;
  }

  // Run the firmware for one timestep's worth of clock cycles.
  advance(dt) {
    this.micros += dt * 1e6;
    if (!this.firmware || this.error) return { cycles: 0 };
    const budget = Math.max(1, Math.floor(this.clockHz * dt));
    const spent = this.firmware.step(budget);
    if (this.firmware.error) {
      this.error = this.firmware.error;
      return { cycles: spent, error: this.error };
    }
    // A program that spends every cycle it is given, for a long time, without
    // finishing a pass of loop(), is stuck. Saying so is the whole value of
    // noticing — a hung board looks identical to a board doing nothing.
    if (spent >= budget && this.firmware.completedIterations === this.lastIterations) this.starvedSteps += 1;
    else this.starvedSteps = 0;
    this.lastIterations = this.firmware.completedIterations;
    return { cycles: spent, starved: this.starvedSteps };
  }

  view() {
    return {
      clockHz: this.clockHz,
      micros: Math.round(this.micros),
      iterations: this.firmware?.completedIterations ?? 0,
      output: this.firmware?.output?.slice(-40) ?? [],
      error: this.error ? { message: this.error.message, code: this.error.code, line: this.error.line } : null,
      pins: Object.fromEntries([...this.pins].map(([name, pin]) => [name, {
        mode: ["input", "output", "pullup"][pin.mode],
        driving: pin.mode === PIN_MODES.OUTPUT ? (pin.duty === null ? (pin.value ? "high" : "low") : `pwm ${Math.round(pin.duty * 100)}%`) : "",
        volts: Math.round(pin.voltage * 1000) / 1000
      }]))
    };
  }
}

export function createMcus(components, firmwareBySource = new Map()) {
  const chips = new Map();
  for (const component of components) {
    if (component.kind !== "mcu") continue;
    const chip = new Mcu(component);
    const source = firmwareBySource.get(component.id);
    if (source) {
      try { chip.load(source); } catch { /* the error is on the chip and reported from there */ }
    }
    chips.set(component.id, chip);
  }
  return chips;
}

export { FirmwareError };
