// The world the sensors are in.
//
// A sensor with nothing to sense is a resistor with an interesting name. A
// thermistor that is always at 20°C teaches nothing about a thermistor, and a
// wheel sensor on a bicycle that never moves is indistinguishable from a broken
// one. So the sandbox has surroundings: a temperature, a road speed, a tilt,
// a light level — the quantities the parts in sensors.mjs actually respond to.
//
// Each one is either a number or a ramp, and nothing more elaborate. A ramp
// covers the question these exist to answer — "does my board read the right
// speed while I accelerate away from the lights" — and every richer scheme I
// considered (piecewise tables, expressions, recorded rides) answers the same
// question with more ways to get it wrong.

export const QUANTITIES = Object.freeze({
  temperature: { unit: "°C", default: 20, label: "temperature" },
  // Road speed, because that is the number on a bike computer. What a wheel
  // sensor actually sees is derived from it and the wheel's circumference.
  speed: { unit: "km/h", default: 0, label: "road speed" },
  // In g, and the resting value is not zero. A board lying flat reads 1g on
  // whichever axis points up, because gravity does not switch off when the
  // board stops moving — which is the single most common surprise the first
  // time anyone reads an accelerometer.
  accelX: { unit: "g", default: 0, label: "acceleration, X" },
  accelY: { unit: "g", default: 0, label: "acceleration, Y" },
  accelZ: { unit: "g", default: 1, label: "acceleration, Z" },
  light: { unit: "lux", default: 200, label: "light" }
});

export const QUANTITY_NAMES = Object.freeze(Object.keys(QUANTITIES));

export function conditionError(message, code = "CIRCUIT_CONDITION_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

// Everything at its resting value, which is what a bench looks like.
export function createConditions() {
  const conditions = new Map();
  for (const [name, quantity] of Object.entries(QUANTITIES)) {
    conditions.set(name, { value: quantity.default });
  }
  return conditions;
}

// Read one, validating as it goes.
//
// `{ value }` holds; `{ from, to, seconds }` moves between the two over that
// long and then holds at the far end. Holding rather than repeating, because a
// ramp that silently looped would make a run's answer depend on its length in a
// way nothing on screen would explain.
export function normaliseCondition(name, input) {
  if (!QUANTITIES[name]) {
    throw conditionError(`There is no such condition as ${name}. Evolv knows about: ${QUANTITY_NAMES.join(", ")}.`);
  }
  if (typeof input === "number" || typeof input === "string") {
    const value = Number(input);
    if (!Number.isFinite(value)) throw conditionError(`${name} has to be a number.`);
    return { value };
  }
  if (input && typeof input === "object" && (input.from !== undefined || input.to !== undefined)) {
    const from = Number(input.from ?? QUANTITIES[name].default);
    const to = Number(input.to);
    const seconds = Number(input.seconds);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw conditionError(`${name} needs numbers to ramp between.`);
    if (!Number.isFinite(seconds) || seconds <= 0) throw conditionError(`A ramp needs how long it takes, in seconds.`);
    return { from, to, seconds };
  }
  const value = Number(input?.value);
  if (!Number.isFinite(value)) throw conditionError(`${name} has to be a number, or a ramp with from, to and seconds.`);
  return { value };
}

// What every quantity is at this instant.
export function conditionsAt(conditions, time = 0) {
  const now = {};
  for (const [name, quantity] of Object.entries(QUANTITIES)) {
    const setting = conditions?.get?.(name) ?? { value: quantity.default };
    if (setting.value !== undefined) {
      now[name] = setting.value;
      continue;
    }
    const progress = Math.min(1, Math.max(0, time / setting.seconds));
    now[name] = setting.from + ((setting.to - setting.from) * progress);
  }
  return now;
}

// How much of a quantity has accumulated by an instant — its integral from the
// start of the run.
//
// The pair to conditionsAt, and it has to be kept as one: anything that counts
// something up needs the area under the curve, not the height of it. A wheel
// sensor pulsing at the current speed times the elapsed time counts a rider who
// accelerates from rest as though they had been going at their final speed the
// whole way, which is out by a factor of two before any of the rest of the
// arithmetic starts.
//
// Exact rather than accumulated, because the world only has two shapes in it: a
// constant integrates to a rectangle and a ramp to a trapezium. A third shape
// would need a third case here, which is why this sits next to the function it
// belongs with rather than somewhere it could be forgotten.
export function integrateCondition(conditions, name, time = 0) {
  const setting = conditions?.get?.(name) ?? { value: QUANTITIES[name]?.default ?? 0 };
  const elapsed = Math.max(0, Number(time) || 0);
  if (setting.value !== undefined) return setting.value * elapsed;
  const { from, to, seconds } = setting;
  if (elapsed <= seconds) return (from * elapsed) + (((to - from) * elapsed * elapsed) / (2 * seconds));
  // The trapezium under the ramp, then a rectangle at the far end.
  return ((from + to) / 2 * seconds) + (to * (elapsed - seconds));
}

export function describeCondition(name, setting) {
  const { unit, label } = QUANTITIES[name] || { unit: "", label: name };
  if (setting?.value !== undefined) return `${label} ${trim(setting.value)}${unit}`;
  return `${label} ${trim(setting.from)}${unit} to ${trim(setting.to)}${unit} over ${trim(setting.seconds)}s`;
}

// What the whole world is, said the way a person would say it. Only the parts
// that have been moved off their resting value, because a list that always
// recites all six buries the one that was changed.
export function describeConditions(conditions) {
  const moved = [...(conditions?.entries?.() || [])].filter(([name, setting]) =>
    setting.value === undefined || setting.value !== QUANTITIES[name].default);
  if (!moved.length) return "still, at room temperature";
  return moved.map(([name, setting]) => describeCondition(name, setting)).join(", ");
}

const trim = (value) => String(Number(Number(value).toPrecision(6)));
