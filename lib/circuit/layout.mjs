// Where each part sits on the page, and how the wires get there.
//
// The model never chooses this. It describes a netlist — a 220Ω resistor from
// VCC to N1 — and the geometry is computed here, because a model placing
// symbols on a grid produces crossed, unreadable wiring, and none of it would
// make the circuit any more or less correct.
//
// Determinism is the requirement that shapes everything below. The same netlist
// has to produce the same picture every time, or a saved scene reopens looking
// different, a screenshot cannot be compared, and a test asserting geometry is
// a coin toss. Every ordering here is therefore explicit — sorted by id or by
// net name — and nothing depends on the order parts were added or on the
// iteration order of an object.

import { PARTS } from "./parts.mjs";

export const GRID = 20;
export const COLUMN_WIDTH = 8 * GRID;
export const ROW_HEIGHT = 5 * GRID;
export const MARGIN = 3 * GRID;
// A symbol's footprint. Pins sit on the left and right edges at its centre
// line, which is what makes orthogonal routing possible at all.
export const SYMBOL_WIDTH = 3 * GRID;
export const SYMBOL_HEIGHT = 2 * GRID;

// Rank each part by how far it is from a power source, following the nets.
//
// This is what gives a schematic its familiar left-to-right shape: supplies at
// the left edge, then whatever they feed, then whatever that feeds. Breadth
// first, from a sorted starting set, so the ranking is a property of the circuit
// rather than of the walk.
export function rankComponents(components) {
  const byId = new Map(components.map((component) => [component.id, component]));
  const netMembers = new Map();
  for (const component of [...components].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const pin of PARTS[component.kind].pins) {
      const net = component.pins[pin];
      if (!net) continue;
      if (!netMembers.has(net)) netMembers.set(net, []);
      netMembers.get(net).push(component.id);
    }
  }

  const rank = new Map();
  const sources = components
    .filter((component) => component.kind === "battery" || component.kind === "supply")
    .map((component) => component.id)
    .sort();
  // A circuit with no source still has to be drawn, so fall back to the
  // alphabetically first part rather than producing nothing.
  const roots = sources.length ? sources : components.map((component) => component.id).sort().slice(0, 1);
  const queue = [...roots];
  for (const id of roots) rank.set(id, 0);

  while (queue.length) {
    const id = queue.shift();
    const depth = rank.get(id);
    const component = byId.get(id);
    if (!component) continue;
    const neighbours = [];
    for (const pin of PARTS[component.kind].pins) {
      const net = component.pins[pin];
      if (!net) continue;
      for (const other of netMembers.get(net) || []) {
        if (other !== id && !rank.has(other)) neighbours.push(other);
      }
    }
    for (const other of [...new Set(neighbours)].sort()) {
      if (rank.has(other)) continue;
      rank.set(other, depth + 1);
      queue.push(other);
    }
  }

  // Anything the walk never reached — a part wired to nothing — still needs a
  // place, put after everything connected so it is visibly off on its own.
  const unreached = components.map((component) => component.id).filter((id) => !rank.has(id)).sort();
  const deepest = Math.max(0, ...rank.values());
  for (const id of unreached) rank.set(id, deepest + 1);
  return rank;
}

// Place parts into columns by rank, rows by id within a column.
export function placeComponents(components) {
  const rank = rankComponents(components);
  const columns = new Map();
  for (const component of [...components].sort((left, right) => left.id.localeCompare(right.id))) {
    const column = rank.get(component.id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(component);
  }

  const placed = [];
  for (const column of [...columns.keys()].sort((left, right) => left - right)) {
    const members = columns.get(column);
    members.forEach((component, row) => {
      const x = MARGIN + (column * COLUMN_WIDTH);
      const y = MARGIN + (row * ROW_HEIGHT);
      const definition = PARTS[component.kind];
      placed.push({
        id: component.id,
        kind: component.kind,
        symbol: definition.symbol,
        label: definition.describe(component.values || {}),
        x, y,
        width: SYMBOL_WIDTH,
        height: SYMBOL_HEIGHT,
        pins: pinPoints(component, x, y)
      });
    });
  }
  return placed;
}

// Where each pin of a placed symbol sits.
//
// Two-pin parts face left and right, which is what makes a series chain read as
// a line. A ground faces down, because that is the direction the symbol points.
// A three-pin part puts its middle pin below, which is where a potentiometer's
// wiper belongs.
function pinPoints(component, x, y) {
  const definition = PARTS[component.kind];
  const pins = definition.pins;
  const centreY = y + (SYMBOL_HEIGHT / 2);
  if (component.kind === "ground") {
    return { [pins[0]]: { x: x + (SYMBOL_WIDTH / 2), y, net: component.pins[pins[0]] || "" } };
  }
  if (pins.length === 3) {
    return {
      [pins[0]]: { x, y: centreY, net: component.pins[pins[0]] || "" },
      [pins[1]]: { x: x + (SYMBOL_WIDTH / 2), y: y + SYMBOL_HEIGHT, net: component.pins[pins[1]] || "" },
      [pins[2]]: { x: x + SYMBOL_WIDTH, y: centreY, net: component.pins[pins[2]] || "" }
    };
  }
  return {
    [pins[0]]: { x, y: centreY, net: component.pins[pins[0]] || "" },
    [pins[1]]: { x: x + SYMBOL_WIDTH, y: centreY, net: component.pins[pins[1]] || "" }
  };
}

// Wires, as a spine per net with a stub to each pin.
//
// This is how a schematic is actually drawn: everything on one net meets a
// single vertical run rather than every pin being joined to every other. It also
// means a net with four connections draws four stubs and one spine instead of
// six crossing diagonals.
export function routeNets(placed) {
  const points = new Map();
  for (const symbol of placed) {
    for (const [pin, point] of Object.entries(symbol.pins)) {
      if (!point.net) continue;
      if (!points.has(point.net)) points.set(point.net, []);
      points.get(point.net).push({ ...point, component: symbol.id, pin });
    }
  }

  const wires = [];
  for (const net of [...points.keys()].sort()) {
    const ends = points.get(net).sort((left, right) => (left.x - right.x) || (left.y - right.y) || left.component.localeCompare(right.component));
    if (ends.length < 2) {
      // A single pin on a net has nothing to join to. Drawn as a short stub so
      // it is visible as a loose end rather than silently absent — the netlist
      // reports it as a floating net, and the picture should agree.
      wires.push({ net, points: [[ends[0].x, ends[0].y], [ends[0].x + GRID, ends[0].y]], dangling: true });
      continue;
    }
    // The spine sits between the leftmost and rightmost pins, snapped to the
    // grid so runs line up with each other.
    const spineX = snap(ends.reduce((total, end) => total + end.x, 0) / ends.length);
    const top = Math.min(...ends.map((end) => end.y));
    const bottom = Math.max(...ends.map((end) => end.y));
    if (bottom !== top) wires.push({ net, points: [[spineX, top], [spineX, bottom]], spine: true });
    for (const end of ends) {
      if (end.x === spineX) continue;
      wires.push({ net, points: [[end.x, end.y], [spineX, end.y]], component: end.component, pin: end.pin });
    }
  }
  return wires;
}

function snap(value) {
  return Math.round(value / GRID) * GRID;
}

// Junction dots: where three or more wires of a net meet, which is the only
// place a schematic marks a connection. Two wires crossing without a dot means
// they are not joined, and drawing dots everywhere destroys that convention.
export function junctions(placed, wires) {
  const counts = new Map();
  for (const wire of wires) {
    for (const [x, y] of wire.points) {
      const key = `${wire.net}@${x},${y}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([key]) => {
      const [net, position] = key.split("@");
      const [x, y] = position.split(",").map(Number);
      return { net, x, y };
    })
    .sort((left, right) => (left.x - right.x) || (left.y - right.y));
}

export function layout(components) {
  const placed = placeComponents(components);
  const wires = routeNets(placed);
  const width = Math.max(COLUMN_WIDTH, ...placed.map((symbol) => symbol.x + symbol.width)) + MARGIN;
  const height = Math.max(ROW_HEIGHT, ...placed.map((symbol) => symbol.y + symbol.height)) + MARGIN;
  return { symbols: placed, wires, junctions: junctions(placed, wires), width, height };
}
