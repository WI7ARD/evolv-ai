// Where the board meets the world.
//
// Evolv had two simulations that had never spoken. The circuit could drive a
// motor and never turn anything; the physics world had wheels nothing decided
// the speed of. And the circuit already had a *pretend* world — the conditions
// in lib/circuit/conditions.mjs, road speed and tilt and temperature, typed in
// by hand — sitting exactly where a real one belonged.
//
// This is the join. A link says one specific thing drives one specific thing,
// and the coupled run steps both simulations and passes values across.
//
// THE TIMESTEPS DO NOT MATCH, AND THAT IS THE WHOLE DIFFICULTY
//
// The circuit solves in microseconds — it has to, with a 16MHz clock and RC
// time constants — and the world steps sixty times a second. That is about four
// orders of magnitude apart. Running them in lockstep is not an option in
// either direction: the world at the circuit's timestep is ten thousand times
// the work for no gain, and the circuit at the world's timestep would erase
// every waveform the sandbox exists to show.
//
// So they are co-simulated. Each runs at its own rate, and they exchange values
// at a coupling interval of one world step. Between exchanges each side sees
// the other held constant — the circuit runs against the world as it was at the
// start of the interval, and the world is driven by the average of what the
// circuit did during it. That is a real approximation with a real error, it
// grows with the coupling interval, and it is reported rather than hidden.
//
// WHAT IS NOT MODELLED
//
// The load goes one way. A stalled wheel does not raise the current the motor
// draws, because the circuit's motor model has its own load term and nothing
// feeds the world's resistance back into it. A coupled run therefore tells you
// what your firmware does about what the world is doing; it does not tell you
// what the world does to your power budget. Said here because a bench that
// quietly got that wrong would be worse than one that never tried.

import { STEPS_PER_SECOND } from "./physics.mjs";

// One world step. The exchange rate between the two simulations, and the
// interval across which each holds the other constant.
export const COUPLING_SECONDS = 1 / STEPS_PER_SECOND;

// How many pixels make a metre.
//
// A stated convention, not a measurement — the physics world has no units of
// its own, and turning a wheel's rim speed into km/h needs one. Every figure
// derived from it carries the same caveat, which is why it is one constant in
// one place rather than a factor buried in a conversion.
export const PIXELS_PER_METRE = 100;

// What a circuit part can drive, and what the world can tell the circuit's
// sensors. Deliberately short: each entry is a quantity both simulations
// genuinely have, rather than a plausible-looking mapping between two numbers
// that happen to be the same shape.
export const DRIVES = Object.freeze({
  // A circuit motor's shaft speed becomes a world motor's shaft speed.
  spin: { part: "motor", reads: "rpm", writes: "motor" }
});

export const SENSES = Object.freeze({
  // A turning wheel becomes road speed, which is what a hall sensor counts.
  speed: { needs: "rpm", condition: "speed", unit: "km/h" },
  // A body's tilt becomes what an accelerometer lying on it would read: at
  // rest, gravity split between the axes. This is the accelerometer equation,
  // not an analogy — a board tilted 30° really does read 0.5g on one axis.
  tilt: { needs: "angleDegrees", condition: "accelX", unit: "g" }
});

// The fastest the world can turn anything: Matter carries angular velocity as
// radians per step, and one radian per step at sixty steps a second is already
// about 573rpm. A circuit motor spinning faster than that saturates, and it is
// said out loud — a 14,000rpm motor quietly becoming a 573rpm one is exactly
// the kind of silent disagreement between two simulations that makes a coupled
// run untrustworthy.
export const MAX_WORLD_RADIANS_PER_STEP = 1;
export const MAX_WORLD_RPM = (MAX_WORLD_RADIANS_PER_STEP * STEPS_PER_SECOND * 60) / (2 * Math.PI);

export const LINK_KINDS = Object.freeze([...Object.keys(DRIVES), ...Object.keys(SENSES)]);
export const MAX_LINKS = 20;

export function couplingError(message, code = "LINK_INVALID", status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

// A circuit motor's rpm as the world wants it: radians per world step.
export function rpmToRadiansPerStep(rpm) {
  const perSecond = ((Number(rpm) || 0) * 2 * Math.PI) / 60;
  return perSecond / STEPS_PER_SECOND;
}

// A wheel's rim speed in km/h, from how fast it turns and how big it is.
//
// v = ωr, then metres per second to km/h. A wheel with no radius reported —
// anything that is not a circle — has no rim, so it contributes no road speed
// rather than a number derived from a radius that was made up.
export function rimSpeedKmh(rpm, radiusPixels) {
  const radius = Number(radiusPixels);
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  const radiansPerSecond = ((Number(rpm) || 0) * 2 * Math.PI) / 60;
  const metresPerSecond = (radiansPerSecond * radius) / PIXELS_PER_METRE;
  return Math.abs(metresPerSecond) * 3.6;
}

// What an accelerometer lying on a body tilted this far would read.
//
// At rest the whole of gravity is shared between the axes by the tilt: level
// is 1g on Z and nothing on X, on its side is 1g on X and nothing on Z. This
// is why an accelerometer works as a tilt sensor at all.
export function tiltToGravity(angleDegrees) {
  const radians = ((Number(angleDegrees) || 0) * Math.PI) / 180;
  return { accelX: round(Math.sin(radians), 4), accelZ: round(Math.cos(radians), 4) };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function normaliseLink(input = {}) {
  const kind = String(input.kind || "").trim();
  if (!LINK_KINDS.includes(kind)) {
    throw couplingError(`A link is one of: ${LINK_KINDS.join(", ")}.`, "LINK_UNKNOWN_KIND");
  }
  const part = String(input.part || "").trim().slice(0, 32);
  const body = String(input.body || "").trim().slice(0, 64);
  if (!body) throw couplingError("A link needs an object in the world to join to.", "LINK_NO_BODY");
  // A drive names a circuit part; a sense reads the world into a condition and
  // has no part of its own, because every sensor watching that condition sees
  // it. Requiring one would be asking which of three thermistors the
  // temperature belongs to.
  if (kind in DRIVES && !part) {
    throw couplingError(`A ${kind} link needs the circuit part doing the driving.`, "LINK_NO_PART");
  }
  return { kind, part, body, direction: kind in DRIVES ? "drive" : "sense" };
}

// A problem carries a key as well as a sentence.
//
// The sentence names the figures, which change every interval as a motor spins
// up; the key names the fault, which does not. Collecting on the sentence meant
// one saturating link produced four hundred near-identical lines — a wall of
// text describing one fact.
function problem(key, message) { return { key, message }; }

// Everything one exchange needs to know, worked out from the two perceptions.
//
// Kept as a pure function of what each side reported so it can be tested
// without running either simulation, and so a coupled run has one place where
// the crossing happens rather than a conversion at each call site.
export function exchange(links, { parts = {}, bodies = {} } = {}) {
  const drives = [];
  const conditions = {};
  const problems = [];

  for (const link of links) {
    const body = bodies[link.body];
    if (!body) {
      problems.push(problem(`missing-body:${link.body}`, `${link.body} is not in the world any more, so the ${link.kind} link does nothing.`));
      continue;
    }
    if (link.direction === "drive") {
      const part = parts[link.part];
      if (!part) {
        problems.push(problem(`missing-part:${link.part}`, `${link.part} is not in the circuit any more, so the ${link.kind} link does nothing.`));
        continue;
      }
      const wanted = rpmToRadiansPerStep(part.rpm);
      // Clamped here rather than left to the world to refuse. The world's
      // setter rejects an out-of-range speed, which is right of it — but the
      // answer to "this motor is faster than the world can turn" is to spin as
      // fast as it can and say so, not to fail the whole exchange.
      const applied = Math.max(-MAX_WORLD_RADIANS_PER_STEP, Math.min(MAX_WORLD_RADIANS_PER_STEP, wanted));
      if (applied !== wanted) {
        problems.push(problem(`saturated:${link.part}:${link.body}`,
          `${link.part} is turning at ${Math.round(part.rpm)}rpm, and the world tops out near ${Math.round(MAX_WORLD_RPM)}rpm. ${link.body} is spinning as fast as it can, which is slower than the motor is.`));
      }
      drives.push({ body: link.body, radiansPerStep: applied, saturated: applied !== wanted });
      continue;
    }
    if (link.kind === "speed") {
      conditions.speed = round(rimSpeedKmh(body.rpm, body.radius), 3);
    } else if (link.kind === "tilt") {
      Object.assign(conditions, tiltToGravity(body.angleDegrees));
    }
  }
  return { drives, conditions, problems };
}

// The coupled run.
//
// One exchange per world step, and between exchanges each simulation is left to
// its own timestep. The circuit is advanced by the same interval the world is,
// so simulated time in the two stays together — which is the property that
// makes the readings comparable at all.
export class Coupling {
  #links = new Map();
  #next = 1;

  list() { return [...this.#links.values()]; }

  add(input = {}) {
    if (this.#links.size >= MAX_LINKS) {
      throw couplingError(`A bench holds at most ${MAX_LINKS} links.`, "LINK_TOO_MANY");
    }
    const link = normaliseLink(input);
    // One link per crossing. Two drives on one body would fight over its speed
    // and the last one written would win, which is a race rather than a design.
    for (const existing of this.#links.values()) {
      if (existing.kind === link.kind && existing.body === link.body) {
        throw couplingError(`${link.body} already has a ${link.kind} link.`, "LINK_DUPLICATE", 409);
      }
    }
    const id = `L${this.#next}`;
    this.#next += 1;
    this.#links.set(id, { id, ...link });
    return this.#links.get(id);
  }

  remove(id) {
    const key = String(id || "");
    if (!this.#links.has(key)) return { removed: null };
    this.#links.delete(key);
    return { removed: key };
  }

  clear() {
    this.#links.clear();
    this.#next = 1;
    return { cleared: true };
  }

  snapshot() { return { links: this.list().map(({ id, ...rest }) => rest) }; }

  restore(saved = {}) {
    this.clear();
    for (const link of saved.links || []) {
      try { this.add(link); } catch { /* a link to something no longer here is dropped, not fatal */ }
    }
    return this.list();
  }
}
