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
import { isGroundName } from "./netlist.mjs";

export const GRID = 20;
export const COLUMN_WIDTH = 8 * GRID;
export const ROW_HEIGHT = 7 * GRID;
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
  // Ground is left out of the walk on purpose.
  //
  // Ranking by net adjacency is what gives a schematic its left-to-right shape,
  // but ground touches almost everything, so following it makes every part one
  // step from the supply and the whole circuit stacks into a single column. A
  // plain series loop — supply, resistor, LED — came out as a tall vertical pile
  // instead of the line it is. Following only the signal nets recovers the
  // chain, which is also how a person reads a schematic: power at the left,
  // ground implied everywhere.
  const netMembers = new Map();
  for (const component of [...components].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const pin of PARTS[component.kind].pins) {
      const net = component.pins[pin];
      if (!net || isGroundName(net)) continue;
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
      if (!net || isGroundName(net)) continue;
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

// The vertical channels wires are allowed to run in.
//
// Wires must not cross symbols, and the first version let them: the spine was
// placed at the average of its pins' x positions, which lands in the middle of a
// column as often as not, so a net ran straight through the LED it was supposed
// to connect to. Running the app is what showed it — on paper the arithmetic
// looked reasonable.
//
// Each column of symbols therefore has a gutter after it, and every spine snaps
// to one. This is also what real schematics look like: parts in ranks, wires in
// the space between them.
function gutters(columns) {
  const lanes = [MARGIN - ((COLUMN_WIDTH - SYMBOL_WIDTH) / 2)];
  for (let column = 0; column <= columns; column += 1) {
    lanes.push(MARGIN + (column * COLUMN_WIDTH) + SYMBOL_WIDTH + ((COLUMN_WIDTH - SYMBOL_WIDTH) / 2));
  }
  return lanes.map(snap);
}

// Give each net a channel of its own where it needs one.
//
// Snapping every net to its nearest gutter is not enough: three nets in a small
// circuit all want the same one, so their spines land on the same x and their
// labels print on top of each other. What came out was "NVC2.5G6V" — three
// readings interleaved into nonsense.
//
// This is ordinary channel routing. Nets are assigned nearest-first, and a lane
// is only free for a net whose vertical span does not overlap one already in it
// — two nets that never share a row can happily share a channel, which keeps a
// large circuit from fanning out across the page.
function assignChannels(nets, lanes) {
  const occupied = new Map();
  const assigned = new Map();
  const ordered = [...nets].sort((left, right) => left.centre - right.centre || left.net.localeCompare(right.net));
  for (const { net, centre, top, bottom } of ordered) {
    const byDistance = [...lanes].sort((left, right) => Math.abs(left - centre) - Math.abs(right - centre));
    let chosen = null;
    for (const lane of byDistance) {
      const taken = occupied.get(lane) || [];
      // A one-grid margin, so two labels in neighbouring rows do not touch.
      if (taken.every(([usedTop, usedBottom]) => bottom + GRID < usedTop || top - GRID > usedBottom)) {
        chosen = lane;
        break;
      }
    }
    // Every channel is busy across this span, so open a new one to the right of
    // the last. Widening the drawing is better than stacking two nets on one
    // line, which is unreadable and, on a schematic, actively misleading.
    if (chosen === null) chosen = Math.max(...lanes) + (2 * GRID) + (assigned.size * GRID);
    occupied.set(chosen, [...(occupied.get(chosen) || []), [top, bottom]]);
    assigned.set(net, chosen);
  }
  return assigned;
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

  const columns = Math.max(0, ...placed.map((symbol) => Math.round((symbol.x - MARGIN) / COLUMN_WIDTH)));
  const lanes = gutters(columns);
  // Every net's span, measured before any of them are placed, so the assignment
  // sees the whole picture rather than deciding one net at a time.
  const spans = [...points.keys()].sort().map((net) => {
    const ends = points.get(net);
    return {
      net,
      centre: ends.reduce((total, end) => total + end.x, 0) / ends.length,
      top: Math.min(...ends.map((end) => end.y)),
      bottom: Math.max(...ends.map((end) => end.y))
    };
  }).filter((span) => points.get(span.net).length >= 2);
  const channels = assignChannels(spans, lanes);

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
    // The channel this net was given: a gutter between columns, never through
    // one, and never shared with another net across the same rows.
    const spineX = channels.get(net);
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

// Where to write each net's name and voltage.
//
// Computed here rather than inferred by the renderer from the wires, because
// the renderer got it wrong in a way that was invisible until the layout
// improved: it hung labels off vertical spines, so once a circuit laid out as a
// single left-to-right row — which is what a series loop should look like — the
// nets had no vertical extent, no spine, and therefore no labels at all. Two of
// the three readings simply vanished from the drawing.
//
// A net's label belongs on its own channel when it has one, and above the run
// otherwise. Either way it is a fact about the net, so the layout owns it.
export function netLabels(placed, wires) {
  const anchors = new Map();
  for (const wire of wires) {
    if (wire.dangling) continue;
    if (!anchors.has(wire.net)) anchors.set(wire.net, { xs: [], ys: [], spine: null });
    const anchor = anchors.get(wire.net);
    for (const [x, y] of wire.points) { anchor.xs.push(x); anchor.ys.push(y); }
    if (wire.spine) anchor.spine = wire.points;
  }
  return [...anchors.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([net, anchor]) => {
    if (anchor.spine) {
      const [[x, top], [, bottom]] = anchor.spine;
      return { net, x, y: Math.round((top + bottom) / 2), vertical: true };
    }
    return {
      net,
      x: Math.round((Math.min(...anchor.xs) + Math.max(...anchor.xs)) / 2),
      y: Math.min(...anchor.ys) - 8,
      vertical: false
    };
  });
}

export function layout(components) {
  const placed = placeComponents(components);
  const wires = routeNets(placed);
  // Wide enough for the rightmost gutter as well as the rightmost symbol, and
  // tall enough for the caption under the lowest one.
  const width = Math.max(
    COLUMN_WIDTH,
    ...placed.map((symbol) => symbol.x + symbol.width),
    ...wires.flatMap((wire) => wire.points.map(([x]) => x))
  ) + MARGIN;
  const height = Math.max(ROW_HEIGHT, ...placed.map((symbol) => symbol.y + symbol.height + (3 * GRID))) + MARGIN;
  return { symbols: placed, wires, junctions: junctions(placed, wires), labels: netLabels(placed, wires), width, height };
}
