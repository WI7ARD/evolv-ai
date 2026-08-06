// The physics sandbox: a small 2D world Evolv can build in and look at.
//
// The engine runs headless here, in the server, not in the browser. Three
// reasons, in order of how much they matter:
//
//   1. Perception has to be honest. If the simulation lived in a page, then
//      "what is in the scene" would mean "what some browser tab currently
//      believes", and a model asking with no window open would be told the
//      world is empty. Here the world exists whether or not anyone is
//      watching, and perceive() reads the same bodies the solver just moved.
//   2. The renderer ships no physics library. Evolv's CSP is script-src
//      'self', so a CDN is not an option, and vendoring a physics engine into
//      the page to duplicate a simulation the server already runs would give
//      two answers to every question. The page draws vertices; it computes
//      nothing.
//   3. Determinism. A fixed timestep advanced by an explicit step count
//      reproduces exactly, which is what makes the behaviour testable at all.
//
// Nothing in this module touches the filesystem, the network, or the project.
// A scene is memory, and resetting it costs nothing — which is why the tools
// that drive it sit in the automatic risk tier.

import Matter from "matter-js";

const { Bodies, Body, Composite, Constraint, Engine, Query } = Matter;

// A scene is a toy, not a workload. These bounds keep a runaway model — or a
// held-down button — from turning it into one.
export const MAX_BODIES = 200;
export const MAX_STEPS_PER_CALL = 600;      // 10 seconds at 60Hz
const FIXED_TIMESTEP = 1000 / 60;
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;
const WALL_THICKNESS = 60;

const SHAPES = new Set(["box", "circle", "ramp", "motor"]);

function fail(message, status = 400, code = "PHYSICS_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

// Every number that reaches the solver comes through here. NaN or Infinity in
// a position or a force does not throw — it silently corrupts the body and
// then the whole world, and the failure surfaces much later as bodies
// vanishing. Rejecting at the boundary keeps that impossible.
function finite(value, name, { min = -1e6, max = 1e6, fallback } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw fail(`${name} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw fail(`${name} must be a finite number.`);
  if (number < min || number > max) throw fail(`${name} must be between ${min} and ${max}.`);
  return number;
}

function positive(value, name, { max, fallback }) {
  const number = finite(value, name, { min: 0.1, max, fallback });
  if (number <= 0) throw fail(`${name} must be greater than zero.`);
  return number;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export class PhysicsService {
  #engine = null;
  #motors = [];
  #sequence = 0;
  #labels = new Map();
  #stepped = 0;

  constructor({ gravity = 1 } = {}) {
    this.#engine = Engine.create();
    this.#engine.gravity.y = gravity;
    this.#addBoundaries();
  }

  // Walls exist so dropped objects settle instead of falling forever. They are
  // static and unlisted: a model asking what is in the scene wants to hear
  // about the objects it made, not about the box they live in.
  #addBoundaries() {
    const options = { isStatic: true, label: "boundary", restitution: 0.2, friction: 0.6 };
    const half = WALL_THICKNESS / 2;
    Composite.add(this.#engine.world, [
      Bodies.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT + half, WORLD_WIDTH + WALL_THICKNESS * 2, WALL_THICKNESS, options),
      Bodies.rectangle(-half, WORLD_HEIGHT / 2, WALL_THICKNESS, WORLD_HEIGHT * 3, options),
      Bodies.rectangle(WORLD_WIDTH + half, WORLD_HEIGHT / 2, WALL_THICKNESS, WORLD_HEIGHT * 3, options)
    ]);
  }

  #objects() {
    return Composite.allBodies(this.#engine.world).filter((body) => body.label !== "boundary");
  }

  #nextId(shape) {
    this.#sequence += 1;
    return `${shape}-${this.#sequence}`;
  }

  #find(id) {
    const body = this.#objects().find((candidate) => candidate.label === id);
    if (!body) throw fail(`No object named ${id} is in the scene.`, 404, "PHYSICS_NO_OBJECT");
    return body;
  }

  #guardCapacity() {
    if (this.#objects().length >= MAX_BODIES) {
      throw fail(`The scene already holds ${MAX_BODIES} objects. Remove some or clear it.`, 409, "PHYSICS_FULL");
    }
  }

  #material({ isStatic = false, restitution, friction, density }) {
    return {
      isStatic: Boolean(isStatic),
      restitution: finite(restitution, "bounciness", { min: 0, max: 1, fallback: 0.3 }),
      friction: finite(friction, "friction", { min: 0, max: 1, fallback: 0.4 }),
      density: finite(density, "density", { min: 0.0001, max: 1, fallback: 0.001 })
    };
  }

  #register(body, id, kind, note) {
    body.label = id;
    this.#labels.set(id, { kind, note: String(note || "").slice(0, 200) });
    Composite.add(this.#engine.world, body);
    return this.describe(id);
  }

  addBox({ x, y, width, height, angle, note, ...material } = {}) {
    this.#guardCapacity();
    const body = Bodies.rectangle(
      finite(x, "x", { min: -1000, max: WORLD_WIDTH + 1000 }),
      finite(y, "y", { min: -1000, max: WORLD_HEIGHT + 1000 }),
      positive(width, "width", { max: WORLD_WIDTH, fallback: 50 }),
      positive(height, "height", { max: WORLD_HEIGHT, fallback: 50 }),
      { ...this.#material(material), angle: finite(angle, "angle", { min: -Math.PI * 4, max: Math.PI * 4, fallback: 0 }) }
    );
    return this.#register(body, this.#nextId("box"), "box", note);
  }

  addCircle({ x, y, radius, note, ...material } = {}) {
    this.#guardCapacity();
    const body = Bodies.circle(
      finite(x, "x", { min: -1000, max: WORLD_WIDTH + 1000 }),
      finite(y, "y", { min: -1000, max: WORLD_HEIGHT + 1000 }),
      positive(radius, "radius", { max: WORLD_HEIGHT / 2, fallback: 30 }),
      this.#material(material)
    );
    return this.#register(body, this.#nextId("circle"), "circle", note);
  }

  // A ramp is a static angled surface — the thing you actually want when
  // studying how something slides or rolls, so it is its own verb rather than
  // a box someone has to remember to freeze and rotate.
  addRamp({ x, y, width, height, angle, note, ...material } = {}) {
    this.#guardCapacity();
    const body = Bodies.rectangle(
      finite(x, "x", { min: -1000, max: WORLD_WIDTH + 1000 }),
      finite(y, "y", { min: -1000, max: WORLD_HEIGHT + 1000 }),
      positive(width, "width", { max: WORLD_WIDTH, fallback: 300 }),
      positive(height, "height", { max: WORLD_HEIGHT, fallback: 20 }),
      {
        ...this.#material({ ...material, isStatic: true }),
        angle: finite(angle, "angle", { min: -Math.PI * 4, max: Math.PI * 4, fallback: 0.3 })
      }
    );
    return this.#register(body, this.#nextId("ramp"), "ramp", note);
  }

  // A motor is a wheel pinned in place and driven at a constant rate. The pin
  // is a zero-length constraint to the world, which is what keeps it spinning
  // about its centre instead of being flung across the scene.
  addMotor({ x, y, radius, speed, note, ...material } = {}) {
    this.#guardCapacity();
    const centreX = finite(x, "x", { min: -1000, max: WORLD_WIDTH + 1000 });
    const centreY = finite(y, "y", { min: -1000, max: WORLD_HEIGHT + 1000 });
    const wheel = Bodies.circle(centreX, centreY, positive(radius, "radius", { max: 200, fallback: 40 }), {
      ...this.#material(material), frictionAir: 0
    });
    const id = this.#nextId("motor");
    Composite.add(this.#engine.world, Constraint.create({
      pointA: { x: centreX, y: centreY }, bodyB: wheel, pointB: { x: 0, y: 0 }, length: 0, stiffness: 1
    }));
    this.#motors.push({ id, body: wheel, speed: finite(speed, "speed", { min: -1, max: 1, fallback: 0.2 }) });
    return this.#register(wheel, id, "motor", note);
  }

  setGravity(value) {
    this.#engine.gravity.y = finite(value, "gravity", { min: -5, max: 5 });
    return { gravity: this.#engine.gravity.y };
  }

  // Applying a force needs the body's mass to mean anything, so this takes a
  // velocity change instead: "push it this fast", not "push it this hard".
  push({ id, vx, vy } = {}) {
    const body = this.#find(String(id || ""));
    if (body.isStatic) throw fail(`${body.label} is fixed in place and cannot be pushed.`, 409, "PHYSICS_STATIC");
    Body.setVelocity(body, {
      x: finite(vx, "vx", { min: -100, max: 100, fallback: 0 }),
      y: finite(vy, "vy", { min: -100, max: 100, fallback: 0 })
    });
    return this.describe(body.label);
  }

  remove(id) {
    const body = this.#find(String(id || ""));
    Composite.remove(this.#engine.world, body, true);
    this.#motors = this.#motors.filter((motor) => motor.id !== body.label);
    this.#labels.delete(body.label);
    return { removed: body.label };
  }

  clear() {
    const removed = this.#objects().length;
    Composite.clear(this.#engine.world, false, true);
    this.#motors = [];
    this.#labels.clear();
    this.#sequence = 0;
    this.#stepped = 0;
    this.#addBoundaries();
    return { removed };
  }

  // Time only moves when asked. A wall-clock loop would make every reading
  // depend on when it was taken, and two identical scenes would diverge; an
  // explicit step count means a test and a model see the same world.
  step(steps = 1) {
    const count = Math.floor(finite(steps, "steps", { min: 1, max: MAX_STEPS_PER_CALL, fallback: 1 }));
    for (let index = 0; index < count; index += 1) {
      for (const motor of this.#motors) Body.setAngularVelocity(motor.body, motor.speed);
      Engine.update(this.#engine, FIXED_TIMESTEP);
    }
    this.#stepped += count;
    return { steps: count, elapsedSeconds: round(this.#stepped / 60, 3) };
  }

  describe(id) {
    const body = this.#find(String(id || ""));
    const meta = this.#labels.get(body.label) || {};
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    return {
      id: body.label,
      kind: meta.kind || "box",
      ...(meta.note ? { note: meta.note } : {}),
      x: round(body.position.x), y: round(body.position.y),
      angleDegrees: round((body.angle * 180) / Math.PI, 1),
      vx: round(body.velocity.x, 3), vy: round(body.velocity.y, 3),
      speed: round(speed, 3),
      mass: body.isStatic ? null : round(body.mass, 3),
      fixed: body.isStatic,
      // Below this, motion is indistinguishable from solver jitter. Saying
      // "resting" is more useful to a reader than a velocity of 0.004.
      resting: body.isStatic || speed < 0.05,
      offScreen: body.position.y > WORLD_HEIGHT + 200
    };
  }

  // Perception. Deliberately a plain object with no methods and no live
  // references into the world: whatever reads this cannot accidentally move
  // anything, and the snapshot stays true to the moment it was taken.
  perceive() {
    const objects = this.#objects().map((body) => this.describe(body.label));
    const moving = objects.filter((object) => !object.resting && !object.fixed);
    const contacts = [];
    const pairs = this.#engine.pairs?.list || [];
    for (const pair of pairs) {
      if (!pair.isActive) continue;
      const a = pair.bodyA.label, b = pair.bodyB.label;
      if (a === "boundary" && b === "boundary") continue;
      contacts.push({ a: a === "boundary" ? "wall" : a, b: b === "boundary" ? "wall" : b });
    }
    return {
      gravity: this.#engine.gravity.y,
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      elapsedSeconds: round(this.#stepped / 60, 3),
      objectCount: objects.length,
      capacity: MAX_BODIES,
      settled: moving.length === 0,
      objects,
      contacts,
      // A sentence a model can put straight into an answer, so it does not
      // have to narrate coordinates to say something obvious.
      summary: objects.length === 0
        ? "The scene is empty."
        : `${objects.length} object(s), ${moving.length} still moving, gravity ${this.#engine.gravity.y}.`
    };
  }

  // Drawing data for the renderer: absolute vertices, already solved. The page
  // needs no geometry code and no physics library to draw a frame.
  frame() {
    return {
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      gravity: this.#engine.gravity.y,
      elapsedSeconds: round(this.#stepped / 60, 3),
      bodies: this.#objects().map((body) => {
        const meta = this.#labels.get(body.label) || {};
        return {
          id: body.label,
          kind: meta.kind || "box",
          fixed: body.isStatic,
          circleRadius: body.circleRadius ? round(body.circleRadius) : null,
          x: round(body.position.x), y: round(body.position.y),
          angle: round(body.angle, 4),
          vertices: body.vertices.map((vertex) => [round(vertex.x, 1), round(vertex.y, 1)])
        };
      })
    };
  }

  // Which object is under a click, so the page can select without knowing
  // anything about geometry.
  at(x, y) {
    const point = { x: finite(x, "x"), y: finite(y, "y") };
    const [hit] = Query.point(this.#objects(), point);
    return hit ? this.describe(hit.label) : null;
  }

  apply(action, parameters = {}) {
    switch (String(action || "")) {
      case "create_box": return this.addBox(parameters);
      case "create_circle": return this.addCircle(parameters);
      case "create_ramp": return this.addRamp(parameters);
      case "create_motor": return this.addMotor(parameters);
      case "set_gravity": return this.setGravity(parameters.gravity);
      case "push": return this.push(parameters);
      case "remove": return this.remove(parameters.id);
      case "step": return this.step(parameters.steps);
      case "clear": return this.clear();
      default: throw fail(`Unknown physics action: ${action}`);
    }
  }
}

export const PHYSICS_SHAPES = SHAPES;
