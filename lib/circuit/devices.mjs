// The parts that do something you can watch.
//
// Everything up to here computed numbers. A motor turns, an LED gets brighter,
// a servo swings to an angle — and all of that is physical state that lives
// outside the matrix and has to be integrated alongside it, one step at a time,
// from the currents the solver just produced.
//
// The motor is the one worth modelling properly, and it is modelled properly.
// A motor is not "a thing that spins at a speed proportional to voltage": it is
// a resistance, an inductance, and a voltage source that grows with speed. Every
// behaviour motors are known for falls out of those three — the inrush when it
// starts, the way it slows under load, the stall current that melts drivers —
// and none of them has to be special-cased. Getting that right is the
// difference between a sandbox that teaches you something and one that agrees
// with you.

// A small brushed DC motor, of the kind in a toy or a fan. The figures are for
// a 6V part: three ohms of winding, a couple of amps at stall, seven thousand
// rpm off load.
export const MOTOR_DEFAULTS = Object.freeze({
  resistance: 3,          // Ω, winding
  inductance: 1.5e-3,     // H
  ke: 0.008,              // V per rad/s — and, in SI, N·m per A as well
  inertia: 5e-7,          // kg·m², rotor
  friction: 1e-7,         // N·m·s/rad, viscous
  loadTorque: 0           // N·m, whatever it is turning
});

// A hobby servo: 1ms of pulse is one end, 2ms the other, repeated every 20ms.
export const SERVO_PULSE_MIN = 0.001;
export const SERVO_PULSE_MAX = 0.002;
export const SERVO_SWEEP_DEGREES = 180;
// How fast it can actually get there. A cheap servo takes about 0.12s per 60°,
// so it does not teleport when the pulse width changes — which is exactly the
// thing that surprises people writing their first sweep.
export const SERVO_DEGREES_PER_SECOND = 500;

export function motorValues(values = {}) {
  const merged = { ...MOTOR_DEFAULTS };
  for (const key of Object.keys(MOTOR_DEFAULTS)) {
    const given = Number(values[key]);
    if (Number.isFinite(given)) merged[key] = given;
  }
  merged.resistance = Math.max(0.01, merged.resistance);
  merged.inductance = Math.max(1e-9, merged.inductance);
  merged.inertia = Math.max(1e-12, merged.inertia);
  return merged;
}

// A motor over one timestep, as a conductance and a current source.
//
// The branch is a resistance, an inductance and the back-EMF in series:
//
//   v = i·R + L·di/dt + Ke·ω
//
// Backward Euler on the inductance and solving for the current at the end of
// the step collapses all three into one conductance and one source, so the
// solver never needs an internal node or a branch unknown for it. The back-EMF
// term is what makes the motor draw its enormous stall current at rest and
// almost nothing at speed, without either being written down anywhere.
export function motorCompanion(values, dt, past) {
  const motor = motorValues(values);
  const step = Math.max(1e-12, dt);
  const conductance = 1 / (motor.resistance + (motor.inductance / step));
  const backEmf = motor.ke * (past?.speed || 0);
  const stored = (motor.inductance / step) * (past?.current || 0);
  return { conductance, source: conductance * (stored - backEmf), backEmf };
}

// The mechanical half, integrated implicitly so a light rotor cannot make the
// step unstable:
//
//   J·dω/dt = Kt·i − B·ω − T_load
//
// Solving for ω at the end of the step rather than the start is the same choice
// backward Euler makes on the electrical side, and for the same reason: it
// damps instead of ringing.
export function motorSpeed(values, dt, past, current) {
  const motor = motorValues(values);
  const step = Math.max(1e-12, dt);
  const torque = (motor.ke * current) - motor.loadTorque;
  const next = ((past?.speed || 0) + ((step / motor.inertia) * torque))
    / (1 + ((step / motor.inertia) * motor.friction));
  // A load torque bigger than the motor can make does not spin it backwards; it
  // stalls. Letting it reverse would be arithmetically tidy and physically a
  // lie about what a stalled motor does.
  if (motor.loadTorque > 0 && next < 0) return 0;
  return next;
}

export const radiansToRpm = (speed) => (speed * 60) / (2 * Math.PI);

// How bright an LED looks, from the current actually going through it.
//
// Perceived brightness is not proportional to current — the eye is roughly
// logarithmic, and an LED at 2mA looks far more than a tenth as bright as one at
// 20mA. Drawing it linearly makes every dim LED look off, which is the opposite
// of useful when the question is "is this resistor too big".
export function ledBrightness(current, rating = 0.02) {
  const amps = Math.abs(Number(current) || 0);
  if (amps < 1e-6) return 0;
  const fraction = Math.min(1, amps / Math.max(1e-6, rating));
  return Math.min(1, Math.max(0, Math.log10(1 + (9 * fraction))));
}

// Fresh state for everything that moves or remembers.
export function createDeviceState(components) {
  const state = new Map();
  for (const component of components) {
    if (component.kind === "motor") state.set(component.id, { speed: 0, current: 0, turns: 0 });
    if (component.kind === "servo") {
      state.set(component.id, {
        angle: 90, target: 90, high: false, roseAt: 0, pulse: 0
      });
    }
    if (component.kind === "buzzer") {
      state.set(component.id, { high: false, lastEdge: 0, frequency: 0, amplitude: 0 });
    }
  }
  return state;
}

// Advance everything mechanical by one timestep, from the solved currents.
export function advanceDevices(components, { read, currents, state, dt, time }) {
  if (!state) return;
  for (const component of components) {
    const memory = state.get(component.id);
    if (!memory) continue;

    if (component.kind === "motor") {
      const current = currents.get(component.id) ?? 0;
      memory.speed = motorSpeed(component.values || {}, dt, memory, current);
      memory.current = current;
      memory.turns += (memory.speed * dt) / (2 * Math.PI);
      continue;
    }

    if (component.kind === "servo") {
      // A servo is told where to go by how long the pulse is, so the pulse has
      // to be measured — its width, not its duty. A 1ms pulse every 20ms and a
      // 1ms pulse every 5ms mean the same angle and have very different duties,
      // which is why duty is the wrong thing to read.
      const supply = read(component, "vcc") - read(component, "gnd");
      const signal = read(component, "signal") - read(component, "gnd");
      const high = supply > 1 ? signal > supply / 2 : false;
      if (high && !memory.high) memory.roseAt = time;
      if (!high && memory.high && memory.roseAt > 0) {
        const width = time - memory.roseAt;
        // Ignore anything outside what a servo would accept, rather than
        // swinging to an end stop because a stray edge went by.
        if (width > SERVO_PULSE_MIN * 0.5 && width < SERVO_PULSE_MAX * 1.5) {
          memory.pulse = width;
          const fraction = (width - SERVO_PULSE_MIN) / (SERVO_PULSE_MAX - SERVO_PULSE_MIN);
          memory.target = Math.min(SERVO_SWEEP_DEGREES, Math.max(0, fraction * SERVO_SWEEP_DEGREES));
        }
      }
      memory.high = high;
      // It takes time to get there.
      const limit = SERVO_DEGREES_PER_SECOND * dt;
      const gap = memory.target - memory.angle;
      memory.angle += Math.max(-limit, Math.min(limit, gap));
      continue;
    }

    if (component.kind === "buzzer") {
      const across = read(component, "a") - read(component, "b");
      const high = across > 1;
      if (high && !memory.high) {
        if (memory.lastEdge > 0) {
          const period = time - memory.lastEdge;
          if (period > 0) memory.frequency = 1 / period;
        }
        memory.lastEdge = time;
      }
      memory.high = high;
      memory.amplitude = Math.max(memory.amplitude * 0.999, Math.abs(across));
    }
  }
}

// The note a frequency is closest to. A buzzer that says "440Hz" is telling you
// less than one that says "440Hz — A4", and the second costs twelve lines.
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export function noteFor(frequency) {
  const hertz = Number(frequency);
  if (!Number.isFinite(hertz) || hertz < 16) return "";
  const semitones = Math.round(12 * Math.log2(hertz / 440));
  const octave = Math.floor((semitones + 57) / 12);
  const name = NOTE_NAMES[((semitones + 9) % 12 + 12) % 12];
  return `${name}${octave}`;
}

// What the renderer should draw for each device, computed here so the page goes
// on computing nothing.
export function deviceView(component, state, currents, ratings = {}) {
  const memory = state?.get(component.id);
  switch (component.kind) {
    case "led": {
      const current = currents?.[component.id] ?? currents?.get?.(component.id) ?? 0;
      return { lit: ledBrightness(current, ratings.amps || 0.02), colour: component.values?.colour || "red" };
    }
    case "motor": {
      const rpm = radiansToRpm(memory?.speed || 0);
      return {
        rpm: Math.round(rpm),
        turns: memory?.turns || 0,
        amps: memory?.current || 0,
        stalled: Math.abs(rpm) < 1 && Math.abs(memory?.current || 0) > 0.05
      };
    }
    case "servo":
      return { angle: Math.round((memory?.angle || 0) * 10) / 10, pulseMs: Math.round((memory?.pulse || 0) * 1e5) / 100 };
    case "buzzer":
      return {
        frequency: Math.round(memory?.frequency || 0),
        note: noteFor(memory?.frequency),
        amplitude: Math.round((memory?.amplitude || 0) * 100) / 100
      };
    default:
      return null;
  }
}

export function describeDevice(kind, values = {}) {
  switch (kind) {
    case "motor": return `${values.volts || 6}V DC motor`;
    case "servo": return "Hobby servo";
    case "buzzer": return "Piezo buzzer";
    case "rgbled": return "RGB LED";
    case "sevenseg": return `7-segment display (common ${values.common || "cathode"})`;
    default: return kind;
  }
}
