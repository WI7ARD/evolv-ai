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

const { Bodies, Body, Composite, Composites, Constraint, Engine, Query, Vertices } = Matter;

// A scene is a toy, not a workload. These bounds keep a runaway model — or a
// held-down button — from turning it into one. The limit counts objects a
// person would name, not solver bodies: a ragdoll is one thing, not twelve.
export const MAX_BODIES = 200;
export const MAX_PARTS = 900;
export const MAX_STEPS_PER_CALL = 600;      // 10 seconds at 60Hz
const FIXED_TIMESTEP = 1000 / 60;
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;
const WALL_THICKNESS = 60;

const SHAPES = new Set([
  "box", "circle", "ramp", "motor", "polygon", "triangle", "star",
  "gear", "chain", "rope", "ragdoll", "car"
]);

// Materials are the vocabulary people actually reason in. "Ice" is a thing you
// can picture; frictionStatic 0.01 is not. The numbers stay adjustable, but
// nobody should have to invent them to drop a rubber ball.
export const MATERIALS = Object.freeze({
  default: { label: "Default", density: 0.001, friction: 0.4, restitution: 0.3 },
  rubber: { label: "Bouncy rubber", density: 0.0012, friction: 0.9, restitution: 0.9 },
  metal: { label: "Heavy metal", density: 0.008, friction: 0.3, restitution: 0.08 },
  wood: { label: "Light wood", density: 0.0005, friction: 0.6, restitution: 0.25 },
  ice: { label: "Ice", density: 0.0009, friction: 0, frictionStatic: 0, restitution: 0.05 }
});

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
  // id -> { kind, note, bodies, constraints }. Every body in a group carries
  // the group id as its label, so a hit test on any limb finds the ragdoll.
  #groups = new Map();
  #stepped = 0;
  #wind = 0;
  // What the cursor is currently holding, if anything.
  #held = null;

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
    const group = this.#groups.get(String(id || ""));
    if (!group) throw fail(`No object named ${id} is in the scene.`, 404, "PHYSICS_NO_OBJECT");
    return group;
  }

  // The main body is the one a person means when they name the object: the
  // chassis of a car, the head of a ragdoll, the hub of a gear.
  #anchor(group) {
    return group.bodies[0];
  }

  #guardCapacity(parts = 1) {
    if (this.#groups.size >= MAX_BODIES) {
      throw fail(`The scene already holds ${MAX_BODIES} objects. Remove some or clear it.`, 409, "PHYSICS_FULL");
    }
    if (this.#objects().length + parts > MAX_PARTS) {
      throw fail(`That would push the scene past ${MAX_PARTS} moving parts. Remove something first.`, 409, "PHYSICS_FULL");
    }
  }

  // Named material first, then any explicit override on top of it. Order
  // matters: "metal, but bouncier" has to be expressible.
  #material({ material, isStatic = false, restitution, friction, density } = {}) {
    const name = String(material || "default");
    const preset = MATERIALS[name];
    if (!preset) throw fail(`Unknown material: ${name}. Use ${Object.keys(MATERIALS).join(", ")}.`);
    return {
      isStatic: Boolean(isStatic),
      restitution: finite(restitution, "bounciness", { min: 0, max: 1, fallback: preset.restitution }),
      friction: finite(friction, "friction", { min: 0, max: 1, fallback: preset.friction }),
      density: finite(density, "density", { min: 0.0001, max: 1, fallback: preset.density }),
      ...(preset.frictionStatic !== undefined ? { frictionStatic: preset.frictionStatic } : {}),
      materialName: name
    };
  }

  // Strips the bookkeeping field the solver must never see.
  #bodyOptions(material) {
    const { materialName, ...options } = material;
    return options;
  }

  #register(bodies, constraints, id, kind, note, material = "default") {
    const list = Array.isArray(bodies) ? bodies : [bodies];
    for (const body of list) body.label = id;
    this.#groups.set(id, { kind, note: String(note || "").slice(0, 200), bodies: list, constraints, material });
    Composite.add(this.#engine.world, [...list, ...constraints]);
    return this.describe(id);
  }

  // Positions are validated once, here, so every creator below can trust them.
  #place(x, y) {
    return {
      x: finite(x, "x", { min: -1000, max: WORLD_WIDTH + 1000 }),
      y: finite(y, "y", { min: -1000, max: WORLD_HEIGHT + 1000 })
    };
  }

  #angle(value, fallback = 0) {
    return finite(value, "angle", { min: -Math.PI * 4, max: Math.PI * 4, fallback });
  }

  addBox({ x, y, width, height, angle, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const body = Bodies.rectangle(
      at.x, at.y,
      positive(width, "width", { max: WORLD_WIDTH, fallback: 50 }),
      positive(height, "height", { max: WORLD_HEIGHT, fallback: 50 }),
      { ...this.#bodyOptions(options), angle: this.#angle(angle) }
    );
    return this.#register(body, [], this.#nextId("box"), "box", note, options.materialName);
  }

  addCircle({ x, y, radius, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const body = Bodies.circle(at.x, at.y, positive(radius, "radius", { max: WORLD_HEIGHT / 2, fallback: 30 }), this.#bodyOptions(options));
    return this.#register(body, [], this.#nextId("circle"), "circle", note, options.materialName);
  }

  // A regular n-gon. Three sides is a triangle, which is common enough to
  // deserve its own verb rather than a number nobody remembers to pass.
  addPolygon({ x, y, sides, radius, angle, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const count = Math.round(finite(sides, "sides", { min: 3, max: 12, fallback: 6 }));
    const body = Bodies.polygon(at.x, at.y, count, positive(radius, "radius", { max: WORLD_HEIGHT / 2, fallback: 35 }), {
      ...this.#bodyOptions(options), angle: this.#angle(angle)
    });
    const kind = count === 3 ? "triangle" : "polygon";
    return this.#register(body, [], this.#nextId(kind), kind, note, options.materialName);
  }

  addTriangle(parameters = {}) {
    return this.addPolygon({ ...parameters, sides: 3, radius: parameters.radius ?? 40 });
  }

  // A star is concave, and Matter can only decompose concave outlines with the
  // optional poly-decomp package, which is not installed. Bodies.fromVertices
  // does not fail without it — it quietly returns the convex hull, so a star
  // would silently become a blunt polygon. Building it from triangular parts
  // gives a genuinely concave body with no extra dependency.
  addStar({ x, y, points, radius, innerRadius, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const spikes = Math.round(finite(points, "points", { min: 3, max: 12, fallback: 5 }));
    const outer = positive(radius, "radius", { max: 200, fallback: 45 });
    const inner = positive(innerRadius, "innerRadius", { max: outer * 0.9, fallback: outer * 0.45 });

    const parts = [];
    for (let index = 0; index < spikes; index += 1) {
      const tip = (index / spikes) * Math.PI * 2 - Math.PI / 2;
      const left = tip - Math.PI / spikes;
      const right = tip + Math.PI / spikes;
      const vertices = [
        { x: 0, y: 0 },
        { x: Math.cos(left) * inner, y: Math.sin(left) * inner },
        { x: Math.cos(tip) * outer, y: Math.sin(tip) * outer },
        { x: Math.cos(right) * inner, y: Math.sin(right) * inner }
      ];
      const centre = Vertices.centre(vertices);
      parts.push(Bodies.fromVertices(at.x + centre.x, at.y + centre.y, [vertices], this.#bodyOptions(options)));
    }
    const star = Body.create({ parts, ...this.#bodyOptions(options) });
    Body.setPosition(star, at);
    return this.#register(star, [], this.#nextId("star"), "star", note, options.materialName);
  }

  // A toothed wheel, pinned like a motor so it drives things rather than
  // rolling away. Teeth are parts of one compound body, so they cannot shear
  // off under load the way separate constrained bodies would.
  addGear({ x, y, radius, teeth, speed, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const hubRadius = positive(radius, "radius", { max: 150, fallback: 45 });
    const count = Math.round(finite(teeth, "teeth", { min: 3, max: 16, fallback: 8 }));
    const toothLength = hubRadius * 0.32;

    const parts = [Bodies.circle(at.x, at.y, hubRadius * 0.82, this.#bodyOptions(options))];
    for (let index = 0; index < count; index += 1) {
      const theta = (index / count) * Math.PI * 2;
      parts.push(Bodies.rectangle(
        at.x + Math.cos(theta) * hubRadius,
        at.y + Math.sin(theta) * hubRadius,
        toothLength, toothLength * 1.4,
        { ...this.#bodyOptions(options), angle: theta }
      ));
    }
    const gear = Body.create({ parts, ...this.#bodyOptions(options), frictionAir: 0 });
    Body.setPosition(gear, at);

    const id = this.#nextId("gear");
    const pin = Constraint.create({ pointA: { ...at }, bodyB: gear, pointB: { x: 0, y: 0 }, length: 0, stiffness: 1 });
    this.#motors.push({ id, body: gear, speed: finite(speed, "speed", { min: -1, max: 1, fallback: 0.15 }) });
    return this.#register(gear, [pin], id, "gear", note, options.materialName);
  }

  // A ramp is a static angled surface — the thing you actually want when
  // studying how something slides or rolls, so it is its own verb rather than
  // a box someone has to remember to freeze and rotate.
  addRamp({ x, y, width, height, angle, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material({ ...material, isStatic: true });
    const body = Bodies.rectangle(
      at.x, at.y,
      positive(width, "width", { max: WORLD_WIDTH, fallback: 300 }),
      positive(height, "height", { max: WORLD_HEIGHT, fallback: 20 }),
      { ...this.#bodyOptions(options), angle: this.#angle(angle, 0.3) }
    );
    return this.#register(body, [], this.#nextId("ramp"), "ramp", note, options.materialName);
  }

  // A motor is a wheel pinned in place and driven at a constant rate. The pin
  // is a zero-length constraint to the world, which is what keeps it spinning
  // about its centre instead of being flung across the scene.
  addMotor({ x, y, radius, speed, note, ...material } = {}) {
    this.#guardCapacity();
    const at = this.#place(x, y);
    const options = this.#material(material);
    const wheel = Bodies.circle(at.x, at.y, positive(radius, "radius", { max: 200, fallback: 40 }), {
      ...this.#bodyOptions(options), frictionAir: 0
    });
    const id = this.#nextId("motor");
    const pin = Constraint.create({ pointA: { ...at }, bodyB: wheel, pointB: { x: 0, y: 0 }, length: 0, stiffness: 1 });
    this.#motors.push({ id, body: wheel, speed: finite(speed, "speed", { min: -1, max: 1, fallback: 0.2 }) });
    return this.#register(wheel, [pin], id, "motor", note, options.materialName);
  }

  // Chain and rope are the same construction with different stiffness, which
  // is exactly what distinguishes them physically: a chain resists bending,
  // a rope does not.
  #addLinked(kind, { x, y, links, linkWidth, linkHeight, stiffness, anchored = true, note, ...material } = {}) {
    const count = Math.round(finite(links, "links", { min: 2, max: 30, fallback: kind === "rope" ? 14 : 10 }));
    this.#guardCapacity(count);
    const at = this.#place(x, y);
    const options = this.#material(material);
    const width = positive(linkWidth, "linkWidth", { max: 120, fallback: kind === "rope" ? 26 : 34 });
    const height = positive(linkHeight, "linkHeight", { max: 120, fallback: kind === "rope" ? 8 : 14 });

    const group = Body.nextGroup(true);
    const stack = Composites.stack(at.x, at.y, count, 1, 0, 0, (px, py) =>
      Bodies.rectangle(px, py, width, height, {
        ...this.#bodyOptions(options), collisionFilter: { group }, chamfer: { radius: 3 }
      }));
    Composites.chain(stack, 0.45, 0, -0.45, 0, {
      stiffness: finite(stiffness, "stiffness", { min: 0.05, max: 1, fallback: kind === "rope" ? 0.35 : 0.9 }),
      length: 0, damping: 0.05
    });

    const bodies = Composite.allBodies(stack);
    const constraints = Composite.allConstraints(stack);
    if (anchored) {
      // Unanchored, a chain simply falls in a heap. Hanging is the useful case.
      constraints.push(Constraint.create({
        pointA: { x: at.x, y: at.y }, bodyB: bodies[0], pointB: { x: -width / 2, y: 0 }, length: 0, stiffness: 0.9
      }));
    }
    return this.#register(bodies, constraints, this.#nextId(kind), kind, note, options.materialName);
  }

  addChain(parameters = {}) { return this.#addLinked("chain", parameters); }
  addRope(parameters = {}) { return this.#addLinked("rope", parameters); }

  // A humanoid figure. Every part shares one negative collision group so the
  // limbs pass through each other instead of jittering the figure apart, which
  // is what a naive ragdoll does within a second of being dropped.
  addRagdoll({ x, y, scale, note, ...material } = {}) {
    this.#guardCapacity(9);
    const at = this.#place(x, y);
    const options = this.#material(material);
    const size = finite(scale, "scale", { min: 0.4, max: 2.5, fallback: 1 });
    const group = Body.nextGroup(true);
    const base = { ...this.#bodyOptions(options), collisionFilter: { group } };
    const part = (dx, dy, w, h, extra = {}) =>
      Bodies.rectangle(at.x + dx * size, at.y + dy * size, w * size, h * size, { ...base, chamfer: { radius: 4 }, ...extra });

    const head = Bodies.circle(at.x, at.y - 45 * size, 14 * size, { ...base, restitution: 0.5 });
    const chest = part(0, -12, 38, 44);
    const hips = part(0, 20, 32, 28);
    const armLeftUpper = part(-30, -18, 14, 32);
    const armLeftLower = part(-30, 12, 12, 32);
    const armRightUpper = part(30, -18, 14, 32);
    const armRightLower = part(30, 12, 12, 32);
    const legLeftUpper = part(-12, 52, 16, 40);
    const legLeftLower = part(-12, 90, 14, 38);
    const legRightUpper = part(12, 52, 16, 40);
    const legRightLower = part(12, 90, 14, 38);

    const joint = (bodyA, bodyB, pointA, pointB, stiffness = 0.6) =>
      Constraint.create({ bodyA, bodyB, pointA, pointB, stiffness, length: 0, damping: 0.1 });

    const bodies = [chest, head, hips, armLeftUpper, armLeftLower, armRightUpper, armRightLower,
      legLeftUpper, legLeftLower, legRightUpper, legRightLower];
    const constraints = [
      joint(head, chest, { x: 0, y: 12 * size }, { x: 0, y: -22 * size }, 0.8),
      joint(chest, hips, { x: 0, y: 22 * size }, { x: 0, y: -14 * size }, 0.8),
      joint(chest, armLeftUpper, { x: -18 * size, y: -16 * size }, { x: 0, y: -14 * size }),
      joint(armLeftUpper, armLeftLower, { x: 0, y: 15 * size }, { x: 0, y: -15 * size }),
      joint(chest, armRightUpper, { x: 18 * size, y: -16 * size }, { x: 0, y: -14 * size }),
      joint(armRightUpper, armRightLower, { x: 0, y: 15 * size }, { x: 0, y: -15 * size }),
      joint(hips, legLeftUpper, { x: -10 * size, y: 12 * size }, { x: 0, y: -18 * size }),
      joint(legLeftUpper, legLeftLower, { x: 0, y: 19 * size }, { x: 0, y: -18 * size }),
      joint(hips, legRightUpper, { x: 10 * size, y: 12 * size }, { x: 0, y: -18 * size }),
      joint(legRightUpper, legRightLower, { x: 0, y: 19 * size }, { x: 0, y: -18 * size })
    ];
    return this.#register(bodies, constraints, this.#nextId("ragdoll"), "ragdoll", note, options.materialName);
  }

  // A chassis on two sprung axles. Matter ships a Composites.car helper, but
  // it is deprecated — it warns on every call and takes no body options, so
  // every car would be default plastic. Building it here costs a dozen lines
  // and makes the material, the grip, and the suspension explicit.
  addCar({ x, y, width, height, wheelSize, note, ...material } = {}) {
    this.#guardCapacity(3);
    const at = this.#place(x, y);
    const options = this.#material(material);
    const body = this.#bodyOptions(options);
    const chassisWidth = positive(width, "width", { max: 300, fallback: 110 });
    const chassisHeight = positive(height, "height", { max: 120, fallback: 26 });
    const wheelRadius = positive(wheelSize, "wheelSize", { max: 80, fallback: 22 });
    const axleX = chassisWidth * 0.36;
    const axleY = chassisHeight * 0.5;

    // The parts share a group so the wheels do not collide with their own
    // chassis, which would jam the car in place the moment it was created.
    const group = Body.nextGroup(true);
    const chassis = Bodies.rectangle(at.x, at.y, chassisWidth, chassisHeight, {
      ...body, collisionFilter: { group }, chamfer: { radius: 6 }
    });
    // Wheels want grip regardless of the chassis material, or the car sits
    // and spins. Ice is still allowed to be slippery.
    const wheelFriction = options.materialName === "ice" ? 0 : Math.max(body.friction, 0.8);
    const wheel = (offset) => Bodies.circle(at.x + offset, at.y + axleY, wheelRadius, {
      ...body, collisionFilter: { group }, friction: wheelFriction, density: body.density * 0.6
    });
    const rear = wheel(-axleX);
    const front = wheel(axleX);

    const axle = (target, offset) => Constraint.create({
      bodyA: chassis, pointA: { x: offset, y: axleY }, bodyB: target,
      stiffness: 0.4, damping: 0.25, length: 0
    });
    return this.#register(
      [chassis, rear, front], [axle(rear, -axleX), axle(front, axleX)],
      this.#nextId("car"), "car", note, options.materialName
    );
  }

  // Joints between two existing objects. A spring is soft and springs back; a
  // pin is rigid and does not.
  #connect(kind, { a, b, stiffness, length } = {}) {
    const first = this.#find(String(a || ""));
    const second = this.#find(String(b || ""));
    if (first === second) throw fail("Connect two different objects.");
    const bodyA = this.#anchor(first);
    const bodyB = this.#anchor(second);
    const gap = Math.hypot(bodyA.position.x - bodyB.position.x, bodyA.position.y - bodyB.position.y);
    const constraint = Constraint.create({
      bodyA, bodyB,
      length: kind === "pin" ? gap : finite(length, "length", { min: 0, max: 800, fallback: gap }),
      stiffness: kind === "pin" ? 1 : finite(stiffness, "stiffness", { min: 0.005, max: 1, fallback: 0.05 }),
      damping: kind === "pin" ? 0.1 : 0.02
    });
    const id = this.#nextId(kind === "pin" ? "pin" : "spring");
    this.#groups.set(id, { kind: kind === "pin" ? "pin" : "spring", note: "", bodies: [], constraints: [constraint], material: "default", joins: [a, b] });
    Composite.add(this.#engine.world, constraint);
    return { id, kind: kind === "pin" ? "pin" : "spring", connects: [String(a), String(b)], length: round(constraint.length) };
  }

  addSpring(parameters = {}) { return this.#connect("spring", parameters); }
  addPin(parameters = {}) { return this.#connect("pin", parameters); }

  // Dragging.
  //
  // A grabbed object is held by a soft constraint rather than teleported, so
  // it swings, collides, and knocks things over on the way — which is the
  // whole reason to drag it rather than type coordinates. While the clock is
  // paused there is no solver tick to act on that constraint, so a paused drag
  // moves the object directly instead. Both paths go through the same grab and
  // release, so the caller never has to know which one it got.
  grab({ id, x, y } = {}) {
    const at = this.#place(x, y);
    // Prefer whatever is actually under the cursor: grabbing a ragdoll by the
    // hand should pull the hand, not the chest.
    const [under] = Query.point(this.#objects(), at);
    const key = String(id || under?.label || "");
    const group = this.#find(key);
    const body = under && under.label === key ? under : this.#anchor(group);

    this.release();
    const fixed = body.isStatic;
    const constraint = fixed ? null : Constraint.create({
      pointA: { ...at }, bodyB: body,
      pointB: { x: at.x - body.position.x, y: at.y - body.position.y },
      // Soft enough to feel like dragging through treacle rather than welding
      // the cursor to the body, which throws objects at absurd speeds.
      stiffness: 0.06, damping: 0.35, length: 0
    });
    if (constraint) Composite.add(this.#engine.world, constraint);
    this.#held = { id: key, body, constraint, fixed, at };
    return { held: key, fixed };
  }

  dragTo({ x, y, live = true } = {}) {
    if (!this.#held) throw fail("Nothing is being dragged.", 409, "PHYSICS_NOT_HELD");
    const at = {
      x: finite(x, "x", { min: 0, max: WORLD_WIDTH }),
      y: finite(y, "y", { min: 0, max: WORLD_HEIGHT })
    };
    const held = this.#held;

    if (held.constraint && live) {
      held.constraint.pointA = at;
    } else {
      // Paused, or a fixed object that no force can move: shift every part by
      // the same delta so prefabs keep their shape, and clear the velocity so
      // the object does not fly off the moment the clock restarts.
      const delta = { x: at.x - held.at.x, y: at.y - held.at.y };
      for (const body of this.#find(held.id).bodies) {
        Body.setPosition(body, { x: body.position.x + delta.x, y: body.position.y + delta.y });
        if (!body.isStatic) Body.setVelocity(body, { x: 0, y: 0 });
      }
      if (held.constraint) held.constraint.pointA = at;
    }
    held.at = at;
    return { held: held.id };
  }

  release() {
    if (!this.#held) return { released: null };
    const { id, constraint } = this.#held;
    if (constraint) Composite.remove(this.#engine.world, constraint, true);
    this.#held = null;
    return { released: id };
  }

  // Teleport, for a model that knows where it wants something. Dragging is the
  // cursor's version of this; both preserve a prefab's shape.
  moveTo({ id, x, y } = {}) {
    const key = String(id || "");
    const group = this.#find(key);
    const at = this.#place(x, y);
    const current = this.describe(key);
    const delta = { x: at.x - current.x, y: at.y - current.y };
    for (const body of group.bodies) {
      Body.setPosition(body, { x: body.position.x + delta.x, y: body.position.y + delta.y });
      if (!body.isStatic) Body.setVelocity(body, { x: 0, y: 0 });
    }
    return this.describe(key);
  }

  setGravity(value) {
    this.#engine.gravity.y = finite(value, "gravity", { min: -5, max: 5 });
    return { gravity: this.#engine.gravity.y };
  }

  // Wind is a steady sideways push. It is applied per step rather than stored
  // on the bodies, because a force set once is consumed by the next solver
  // tick and would look like a single gust.
  setWind(value) {
    this.#wind = finite(value, "wind", { min: -3, max: 3 });
    return { wind: this.#wind };
  }

  // Applying a force needs the body's mass to mean anything, so this takes a
  // velocity change instead: "push it this fast", not "push it this hard".
  push({ id, vx, vy } = {}) {
    const key = String(id || "");
    const group = this.#find(key);
    const movable = group.bodies.filter((body) => !body.isStatic);
    if (movable.length === 0) throw fail(`${key} is fixed in place and cannot be pushed.`, 409, "PHYSICS_STATIC");
    const velocity = {
      x: finite(vx, "vx", { min: -100, max: 100, fallback: 0 }),
      y: finite(vy, "vy", { min: -100, max: 100, fallback: 0 })
    };
    // Every part gets the same velocity, so a car or a ragdoll moves off as
    // one object rather than being torn apart at its joints.
    for (const body of movable) Body.setVelocity(body, velocity);
    return this.describe(key);
  }

  remove(id) {
    const key = String(id || "");
    const group = this.#find(key);
    // Deleting what the cursor is holding would leave the drag constraint
    // attached to a body that no longer exists.
    if (this.#held?.id === key) this.release();
    for (const constraint of group.constraints) Composite.remove(this.#engine.world, constraint, true);
    for (const body of group.bodies) Composite.remove(this.#engine.world, body, true);
    this.#motors = this.#motors.filter((motor) => motor.id !== key);
    this.#groups.delete(key);
    // A joint whose end has been deleted would otherwise pull on nothing.
    for (const [jointId, joint] of [...this.#groups]) {
      if (joint.joins?.includes(key)) {
        for (const constraint of joint.constraints) Composite.remove(this.#engine.world, constraint, true);
        this.#groups.delete(jointId);
      }
    }
    return { removed: key };
  }

  clear() {
    const removed = this.#groups.size;
    this.#held = null;
    Composite.clear(this.#engine.world, false, true);
    this.#motors = [];
    this.#groups.clear();
    this.#sequence = 0;
    this.#stepped = 0;
    this.#wind = 0;
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
      if (this.#wind !== 0) {
        // Scaled by mass so wind accelerates everything equally, the way it
        // would in a vacuum-free world — otherwise heavy things ignore it and
        // light things fly away, which reads as a bug rather than as physics.
        for (const body of this.#objects()) {
          if (body.isStatic) continue;
          body.force.x += this.#wind * body.mass * 0.0004;
        }
      }
      Engine.update(this.#engine, FIXED_TIMESTEP);
    }
    this.#stepped += count;
    return { steps: count, elapsedSeconds: round(this.#stepped / 60, 3) };
  }

  describe(id) {
    const key = String(id || "");
    const group = this.#find(key);
    // A joint has no body of its own; it is a relationship between two.
    if (group.bodies.length === 0) {
      return { id: key, kind: group.kind, connects: group.joins || [], fixed: true, resting: true };
    }

    // Mass-weighted, so a ragdoll's position is where its bulk is rather than
    // wherever an arbitrary limb happens to be.
    const movable = group.bodies.filter((body) => !body.isStatic);
    const total = movable.reduce((sum, body) => sum + body.mass, 0);
    const weight = (pick) => (total > 0
      ? movable.reduce((sum, body) => sum + pick(body) * body.mass, 0) / total
      : group.bodies.reduce((sum, body) => sum + pick(body), 0) / group.bodies.length);

    const x = weight((body) => body.position.x);
    const y = weight((body) => body.position.y);
    const vx = movable.length ? weight((body) => body.velocity.x) : 0;
    const vy = movable.length ? weight((body) => body.velocity.y) : 0;
    const speed = Math.hypot(vx, vy);
    const anchor = this.#anchor(group);
    const fixed = group.bodies.every((body) => body.isStatic);

    return {
      id: key,
      kind: group.kind,
      ...(group.note ? { note: group.note } : {}),
      ...(group.material && group.material !== "default" ? { material: group.material } : {}),
      x: round(x), y: round(y),
      angleDegrees: round((anchor.angle * 180) / Math.PI, 1),
      vx: round(vx, 3), vy: round(vy, 3),
      speed: round(speed, 3),
      mass: fixed ? null : round(total, 3),
      fixed,
      ...(group.bodies.length > 1 ? { parts: group.bodies.length } : {}),
      // Below this, motion is indistinguishable from solver jitter. Saying
      // "resting" is more useful to a reader than a velocity of 0.004.
      resting: fixed || speed < 0.05,
      offScreen: y > WORLD_HEIGHT + 200
    };
  }

  // Perception. Deliberately a plain object with no methods and no live
  // references into the world: whatever reads this cannot accidentally move
  // anything, and the snapshot stays true to the moment it was taken.
  perceive() {
    const objects = [...this.#groups.keys()].map((id) => this.describe(id));
    const moving = objects.filter((object) => !object.resting && !object.fixed);

    // Contacts are reported between objects, not parts. A ragdoll lying on the
    // floor generates a dozen pairs; hearing it once is the useful reading.
    const seen = new Set();
    const contacts = [];
    for (const pair of this.#engine.pairs?.list || []) {
      if (!pair.isActive) continue;
      const a = pair.bodyA.label === "boundary" ? "wall" : pair.bodyA.label;
      const b = pair.bodyB.label === "boundary" ? "wall" : pair.bodyB.label;
      if (a === b) continue;
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push({ a, b });
    }

    const parts = this.#objects().length;
    return {
      gravity: this.#engine.gravity.y,
      wind: this.#wind,
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      elapsedSeconds: round(this.#stepped / 60, 3),
      objectCount: objects.length,
      partCount: parts,
      capacity: MAX_BODIES,
      settled: moving.length === 0,
      objects,
      contacts,
      // A sentence a model can put straight into an answer, so it does not
      // have to narrate coordinates to say something obvious.
      summary: objects.length === 0
        ? "The scene is empty."
        : `${objects.length} object(s), ${moving.length} still moving, gravity ${this.#engine.gravity.y}${this.#wind ? `, wind ${this.#wind}` : ""}.`
    };
  }

  // Drawing data for the renderer: absolute vertices, already solved. The page
  // needs no geometry code and no physics library to draw a frame.
  frame() {
    const bodies = [];
    for (const body of this.#objects()) {
      const group = this.#groups.get(body.label);
      // A compound body draws as its parts; the parent's own vertex list is
      // the union hull and would paint a gear as a blob.
      const pieces = body.parts.length > 1 ? body.parts.slice(1) : [body];
      for (const piece of pieces) {
        bodies.push({
          id: body.label,
          kind: group?.kind || "box",
          fixed: body.isStatic,
          circleRadius: piece.circleRadius ? round(piece.circleRadius) : null,
          x: round(piece.position.x), y: round(piece.position.y),
          angle: round(piece.angle, 4),
          vertices: piece.vertices.map((vertex) => [round(vertex.x, 1), round(vertex.y, 1)])
        });
      }
    }

    // Joints are drawn too: an invisible spring makes the scene look broken.
    const links = [];
    for (const [id, group] of this.#groups) {
      for (const constraint of group.constraints) {
        const from = constraint.bodyA
          ? { x: constraint.bodyA.position.x + constraint.pointA.x, y: constraint.bodyA.position.y + constraint.pointA.y }
          : constraint.pointA;
        const to = constraint.bodyB
          ? { x: constraint.bodyB.position.x + constraint.pointB.x, y: constraint.bodyB.position.y + constraint.pointB.y }
          : constraint.pointB;
        if (!from || !to) continue;
        links.push({
          id, kind: group.kind, springy: group.kind === "spring",
          from: [round(from.x, 1), round(from.y, 1)], to: [round(to.x, 1), round(to.y, 1)]
        });
      }
    }

    return {
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
      gravity: this.#engine.gravity.y,
      wind: this.#wind,
      elapsedSeconds: round(this.#stepped / 60, 3),
      bodies,
      links
    };
  }

  // Which object is under a click, so the page can select without knowing
  // anything about geometry.
  at(x, y) {
    const point = { x: finite(x, "x"), y: finite(y, "y") };
    const [hit] = Query.point(this.#objects(), point);
    // Any limb identifies the whole figure, which is what a click means.
    return hit ? this.describe(hit.label) : null;
  }

  // The single dispatch point. The toolbar and the model's tools both arrive
  // here, so a control that works for one cannot be missing for the other.
  apply(action, parameters = {}) {
    switch (String(action || "")) {
      case "create_box": return this.addBox(parameters);
      case "create_circle": return this.addCircle(parameters);
      case "create_ramp": return this.addRamp(parameters);
      case "create_motor": return this.addMotor(parameters);
      case "create_polygon": return this.addPolygon(parameters);
      case "create_triangle": return this.addTriangle(parameters);
      case "create_star": return this.addStar(parameters);
      case "create_gear": return this.addGear(parameters);
      case "create_chain": return this.addChain(parameters);
      case "create_rope": return this.addRope(parameters);
      case "create_ragdoll": return this.addRagdoll(parameters);
      case "create_car": return this.addCar(parameters);
      case "connect_spring": return this.addSpring(parameters);
      case "connect_pin": return this.addPin(parameters);
      case "set_gravity": return this.setGravity(parameters.gravity);
      case "set_wind": return this.setWind(parameters.wind);
      case "move": return this.moveTo(parameters);
      case "grab": return this.grab(parameters);
      case "drag": return this.dragTo(parameters);
      case "release": return this.release();
      case "push": return this.push(parameters);
      case "remove": return this.remove(parameters.id);
      case "step": return this.step(parameters.steps);
      case "clear": return this.clear();
      default: throw fail(`Unknown physics action: ${action}`);
    }
  }
}

export const PHYSICS_SHAPES = SHAPES;

// The actions apply() understands. Exported so the tool schemas and the tests
// are generated from the switch rather than from someone's memory of it.
export const PHYSICS_ACTIONS = Object.freeze([
  "create_box", "create_circle", "create_ramp", "create_motor", "create_polygon",
  "create_triangle", "create_star", "create_gear", "create_chain", "create_rope",
  "create_ragdoll", "create_car", "connect_spring", "connect_pin",
  "set_gravity", "set_wind", "move", "grab", "drag", "release",
  "push", "remove", "step", "clear"
]);

// The buildable kinds, read straight off the dispatch switch above. Deriving
// them means the tool schema, the toolbar, and the code that actually runs can
// never disagree about what exists.
export const PHYSICS_KINDS = Object.freeze(
  PHYSICS_ACTIONS.filter((action) => action.startsWith("create_")).map((action) => action.slice("create_".length))
);
