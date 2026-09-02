import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CircuitService, CIRCUIT_VERSION } from "../lib/circuit.mjs";
import { createDatabase } from "../lib/database.mjs";
import { handleCircuitRoutes } from "../server/circuit-routes.mjs";
import { handleBoardRoutes } from "../server/board-routes.mjs";
import { BenchService } from "../lib/bench.mjs";
import { layout } from "../lib/circuit/layout.mjs";

// A working LED circuit, described the way a model would: parts and net names,
// never coordinates.
function ledCircuit(service) {
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 220, pins: { a: "VCC", b: "N1" } });
  service.apply("add", { kind: "led", colour: "red", pins: { anode: "N1", cathode: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  return service;
}

test("a model describes a circuit and gets real designators back", () => {
  const service = new CircuitService();
  const supply = service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  const resistor = service.apply("add", { kind: "resistor", ohms: 220, pins: { a: "VCC", b: "N1" } });
  const second = service.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "N1", b: "GND" } });
  // R1, R2, PS1 — the vocabulary of every schematic and every parts list.
  assert.equal(supply.id, "PS1");
  assert.equal(resistor.id, "R1");
  assert.equal(second.id, "R2");
});

test("a resistance nobody sells is snapped, and the model is told", () => {
  const service = new CircuitService();
  const added = service.apply("add", { kind: "resistor", ohms: 3_700, pins: { a: "A", b: "B" } });
  assert.equal(added.values.ohms, 3_900, "E12 is what exists in a drawer");
  assert.deepEqual(added.snapped, { asked: 3_700, given: 3_900 },
    "snapping silently would leave the model describing a part it did not get");
});

test("perception answers what the circuit is doing, not what it is made of", () => {
  const view = ledCircuit(new CircuitService()).perceive();
  assert.equal(view.solved, true);
  assert.deepEqual(view.findings, []);
  assert.ok(Math.abs(view.nets.VCC - 5) < 0.01);
  assert.ok(view.nets.N1 > 1.9 && view.nets.N1 < 2.3);
  const led = view.parts.find((part) => part.id === "D1");
  assert.ok(led.amps > 0.011 && led.amps < 0.015, `expected about 13mA, got ${led.amps}`);
  assert.equal(led.description, "red LED");
  assert.equal(view.counts.parts, 4);
});

test("the toolbar and the tools reach the same code", async () => {
  // apply() is the only mutation path. If a route or a tool ever calls a method
  // directly, a part added one way and a part added the other stop agreeing.
  const routes = await readFile(new URL("../server/circuit-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /circuitService\.apply\(action\?\.action, action \|\| \{\}\)/);
  const tools = await readFile(new URL("../lib/tools.mjs", import.meta.url), "utf8");
  const circuitTools = tools.slice(tools.indexOf('name: "circuit_look"'));
  for (const call of ["circuitService.apply(\"add\"", "circuitService.apply(\"wire\"", "circuitService.apply(\"clear\""]) {
    assert.ok(circuitTools.includes(call), `expected ${call} to go through apply()`);
  }
});

test("a saved circuit comes back exactly, and keeps numbering where it left off", () => {
  const service = ledCircuit(new CircuitService());
  const snapshot = service.snapshot();
  assert.equal(snapshot.version, CIRCUIT_VERSION);

  const reopened = new CircuitService();
  reopened.restore(snapshot);
  assert.deepEqual(reopened.snapshot(), snapshot);
  // The next resistor must not collide with the R1 that came back from the save.
  assert.equal(reopened.apply("add", { kind: "resistor" }).id, "R2");
});

test("a circuit from a newer build is refused rather than half-understood", () => {
  // The same rule lib/physics.mjs applies to scenes: a partial restore looks
  // like a corrupted save rather than an incompatible one.
  assert.throws(() => new CircuitService().restore({ version: CIRCUIT_VERSION + 1, components: [] }), (error) => {
    assert.equal(error.code, "CIRCUIT_SCENE_VERSION");
    assert.match(error.message, /newer version of Evolv/);
    return true;
  });
});

test("mistakes are refused with the pins actually available", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "resistor", id: "R1", pins: { a: "A", b: "B" } });
  assert.throws(() => service.apply("wire", { id: "R1", pin: "anode", net: "X" }), (error) => {
    assert.equal(error.code, "CIRCUIT_UNKNOWN_PIN");
    assert.match(error.message, /Its pins are: a, b/, "a refusal has to say what would have worked");
    return true;
  });
  assert.throws(() => service.apply("add", { kind: "transistor" }), (error) => {
    assert.equal(error.code, "CIRCUIT_UNKNOWN_PART");
    assert.match(error.message, /Available:/);
    return true;
  });
  assert.throws(() => service.apply("wire", { id: "R1", pin: "a", net: "has a space" }), (error) => {
    assert.equal(error.code, "CIRCUIT_BAD_NET");
    return true;
  });
});

test("the schematic is the same picture every time", () => {
  // Determinism is what makes a saved circuit reopen looking like itself, and
  // what makes any test of geometry mean anything.
  const service = ledCircuit(new CircuitService());
  const first = service.frame();
  const second = service.frame();
  assert.deepEqual(first, second);

  const parts = service.snapshot().components;
  assert.deepEqual(layout(parts), layout([...parts].reverse()),
    "the order parts were added must not change where they are drawn");
});

test("every net gets a label, however the circuit happens to lay out", () => {
  // This went wrong once and was invisible until the layout got better. Labels
  // used to be inferred by the renderer from vertical wire spines, so the moment
  // a series loop laid out as a single left-to-right row — which is exactly what
  // it should look like — two of the three nets had no vertical extent, no
  // spine, and silently no label. The anchors belong to the layout, which knows.
  const frame = ledCircuit(new CircuitService()).frame();
  const labelled = new Set(frame.labels.map((label) => label.net));
  assert.deepEqual([...labelled].sort(), ["GND", "N1", "VCC"]);
  for (const label of frame.labels) {
    assert.ok(Number.isFinite(label.x) && Number.isFinite(label.y), `${label.net} needs a place to be written`);
  }
});

test("wires never run through a symbol", () => {
  // The first version put each net's spine at the average of its pins' x
  // positions, which lands inside a column as often as not — so a wire ran
  // straight through the LED it was connecting to. Only running the app showed
  // it; the arithmetic looked reasonable on paper.
  const frame = ledCircuit(new CircuitService()).frame();
  for (const wire of frame.wires.filter((item) => item.spine)) {
    const x = wire.points[0][0];
    const [top, bottom] = [wire.points[0][1], wire.points[1][1]];
    for (const symbol of frame.symbols) {
      const horizontallyInside = x > symbol.x && x < symbol.x + symbol.width;
      const verticallyOverlapping = bottom > symbol.y && top < symbol.y + symbol.height;
      assert.ok(!(horizontallyInside && verticallyOverlapping),
        `wire on ${wire.net} passes through ${symbol.id}`);
    }
  }
});

test("two nets never share a channel across the same rows", () => {
  // Three nets snapped to one gutter once, and their labels printed on top of
  // each other as "NVC2.5G6V" — three readings interleaved into nonsense.
  const frame = ledCircuit(new CircuitService()).frame();
  const spines = frame.wires.filter((wire) => wire.spine);
  for (const [index, wire] of spines.entries()) {
    for (const other of spines.slice(index + 1)) {
      if (wire.points[0][0] !== other.points[0][0]) continue;
      const overlap = wire.points[1][1] > other.points[0][1] && wire.points[0][1] < other.points[1][1];
      assert.ok(!overlap, `${wire.net} and ${other.net} share a channel across the same rows`);
    }
  }
});

test("a series loop reads left to right, not as a vertical pile", () => {
  // Ranking followed ground, which touches almost everything, so every part
  // came out one step from the supply and stacked into a single column. A
  // supply, a resistor and an LED in series is a line.
  const frame = ledCircuit(new CircuitService()).frame();
  const byId = Object.fromEntries(frame.symbols.map((symbol) => [symbol.id, symbol]));
  assert.ok(byId.PS1.x < byId.R1.x, "the supply comes before the resistor");
  assert.ok(byId.R1.x < byId.D1.x, "and the resistor before the LED it feeds");
  assert.ok(frame.width > frame.height, "so the drawing is wider than it is tall");
});

test("the frame carries geometry and the numbers, and the page computes neither", () => {
  const frame = ledCircuit(new CircuitService()).frame();
  assert.ok(frame.symbols.length === 4 && frame.wires.length > 0);
  for (const symbol of frame.symbols) {
    assert.ok(Number.isFinite(symbol.x) && Number.isFinite(symbol.y));
    assert.ok(symbol.label, "every symbol carries its own caption");
  }
  assert.ok(frame.nets.VCC !== undefined, "voltages come with the drawing");
  assert.ok(frame.currents.D1 !== undefined, "so do currents");
});

test("the HTTP surface is a window onto the same circuit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-circuit-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "c.db"), defaultPrompt: "test" });
  const circuitService = new CircuitService();
  const bench = new BenchService({ database, circuitService });
  const sent = [];
  const json = (res, status, payload) => sent.push({ status, payload });
  const call = (method, pathname, body) => (pathname.startsWith("/api/boards") ? handleBoardRoutes : handleCircuitRoutes)({
    req: { method },
    res: {},
    url: new URL(`http://local${pathname}`),
    // Called the way the server calls it, arguments and all.
    //
    // This used to be `async () => body`, which accepted anything — and two
    // routes were written as readBody(bodyLimit), missing the request
    // entirely. They threw on the first real request and the tests never
    // noticed, because a stub that ignores its arguments cannot tell a right
    // call from a wrong one.
    readBody: async (request, limit) => {
      assert.equal(request?.method, method, "readBody takes the request first");
      assert.equal(typeof limit, "number", "and the body limit second");
      return body;
    },
    bodyLimit: 1_000_000,
    json,
    circuitService,
    bench
  });

  try {
    await call("POST", "/api/circuit/actions", {
      actions: [
        { action: "add", kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } },
        { action: "add", kind: "resistor", ohms: 220, pins: { a: "VCC", b: "N1" } },
        { action: "add", kind: "led", colour: "red", pins: { anode: "N1", cathode: "GND" } },
        { action: "add", kind: "ground", pins: { pin: "GND" } }
      ]
    });
    assert.equal(sent.at(-1).payload.circuit.solved, true);

    await call("GET", "/api/circuit");
    const perceived = sent.at(-1).payload;
    assert.ok(perceived.nets.N1 > 1.9 && perceived.nets.N1 < 2.3);

    // Saved as a board and reopened. The database never sees inside the
    // snapshot — the service holds no database handle, which is what keeps its
    // tools in the automatic risk tier.
    await call("POST", "/api/boards", { name: "LED test", intent: "Light one LED off 5V" });
    const saved = sent.at(-1).payload.board;
    assert.equal(sent.at(-1).status, 201);
    assert.equal(saved.stages.find((stage) => stage.id === "design").headline, "4 parts");
    assert.equal(saved.stages.find((stage) => stage.id === "intent").state, "done");

    // Running it writes the simulate stage without anyone asking, which is the
    // only way a history stays complete.
    await call("POST", "/api/circuit/run", { seconds: 0.002 });
    await call("GET", `/api/boards/${saved.id}`);
    const afterRun = sent.at(-1).payload.board;
    const simulate = afterRun.stages.find((stage) => stage.id === "simulate");
    assert.equal(simulate.state, "done");
    assert.match(simulate.headline, /from the supply/, "the headline carries what the board draws");

    await call("DELETE", "/api/circuit");
    await call("GET", "/api/circuit");
    assert.equal(sent.at(-1).payload.counts.parts, 0);

    await call("POST", `/api/boards/${saved.id}/open`);
    assert.equal(sent.at(-1).payload.board.name, "LED test");
    await call("GET", "/api/circuit");
    assert.equal(sent.at(-1).payload.counts.parts, 4);

    // A measurement off a real board, compared against what was simulated.
    await call("POST", "/api/circuit/expectations", { subject: "D1", measure: "current", condition: "reaches", value: 0.01 });
    await call("POST", "/api/circuit/check", { seconds: 0.002 });
    await call("POST", `/api/boards/${saved.id}/measurements`, { subject: "D1", measure: "current", value: 0.0134, note: "bench meter" });
    const measured = sent.at(-1).payload.board.measurements[0];
    assert.equal(measured.agreement, "agrees", `expected the bench to agree: ${measured.detail}`);
    assert.match(measured.detail, /Simulated .*, measured 13\.40mA/);

    // An unavailable service is a 503 rather than a crash, matching physics.
    await assert.rejects(() => handleCircuitRoutes({
      req: { method: "GET" }, res: {}, url: new URL("http://local/api/circuit"),
      readBody: async () => ({}), bodyLimit: 1, json, circuitService: null, bench
    }), (error) => {
      assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
      return true;
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("every control the renderer binds exists in the page", async () => {
  // The check that exists because a deleted element once threw inside
  // bindEvents and killed every listener registered after it.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const bound = [...script.matchAll(/\$\("#([a-z0-9-]+)"\)/g)].map((match) => match[1]);
  assert.ok(bound.length >= 5, "the renderer should bind something");
  // Every id it reaches for is optional-chained, so a missing element cannot
  // throw and take the rest of the bindings with it.
  for (const id of new Set(bound)) {
    const uses = [...script.matchAll(new RegExp(`\\$\\("#${id}"\\)(\\??)`, "g"))].map((match) => match[1]);
    assert.ok(uses.every((suffix) => suffix === "?") || script.includes(`const ${id.replace(/-(.)/g, (all, letter) => letter.toUpperCase())} = $("#${id}")`)
      || script.includes(`= $("#${id}")`), `#${id} must be reached safely`);
  }
});

test("every part in the catalogue gets a real reference designator", async () => {
  // The six chips were added to the catalogue and not to the designator table,
  // so a 555 came out labelled "undefined1" — on the schematic, in the parts
  // table, and in the bill of materials. Every test passed; it took looking at
  // the screen. A part with no designator cannot be ordered or found on a board.
  const { PART_KINDS } = await import("../lib/circuit/parts.mjs");
  const service = new CircuitService();
  for (const kind of PART_KINDS) {
    const added = service.apply("add", { kind });
    assert.doesNotMatch(added.id, /undefined/, `${kind} has no designator`);
    assert.match(added.id, /^[A-Z]+[0-9]+$/, `${kind} produced the id ${added.id}`);
  }
});

test("every part in the catalogue has a symbol to draw it with", async () => {
  // A part the solver understands and the renderer cannot draw falls back to a
  // resistor, which is not a missing feature but a silent lie about what is on
  // the page — and the sort of thing nobody notices until they are reading a
  // schematic that says the wrong thing.
  const { PART_KINDS } = await import("../lib/circuit/parts.mjs");
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const drawn = new Set([...script.matchAll(/^ {2}([a-z0-9]+): "M/gm)].map((match) => match[1]));
  for (const kind of PART_KINDS) {
    assert.ok(drawn.has(kind), `${kind} has no symbol; it would be drawn as a resistor`);
  }
});

test("every request the page sends carries a body fetch can actually send", async () => {
  // api() in app.js spreads its options straight into fetch, so a body has to
  // be a string already. Passing an object sends the literal text
  // "[object Object]", the server answers "Invalid JSON body", and every
  // control that posts anything silently does nothing.
  //
  // All five of the circuit page's controls were written that way, and none of
  // the tests noticed because they drive the routes directly. This is what a
  // test of the page rather than the server looks like.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const bodies = [...script.matchAll(/body:\s*([^,\n]+)/g)].map((match) => match[1].trim());
  assert.ok(bodies.length >= 4, "the page should be sending some bodies");
  for (const body of bodies) {
    assert.ok(body.startsWith("JSON.stringify") || body.startsWith('"') || body.startsWith("`"),
      `body must be serialised before fetch sees it, found: ${body}`);
  }
});

test("the page draws and computes nothing", async () => {
  // The solver lives in the server. A page doing its own arithmetic would give
  // a second answer to every question, with no way to tell which one a model
  // was looking at.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const code = script.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["Math.exp", "stampConductance", "solveNetlist", "MnaSystem"]) {
    assert.ok(!code.includes(forbidden), `${forbidden} does not belong in the renderer`);
  }
});

test("the verdict on screen comes from the board when this tab has not run a check", async () => {
  // The page showed "2 expectations, not yet checked" directly beneath a
  // timeline reading "All 2 expectations met" — both true, one of them only
  // about checks run since the tab opened. Two panels on one screen disagreeing
  // is worse than either being absent.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  assert.match(script, /renderChecks\(state\.checks\)\s*\n\s*\|\| renderChecks\(state\.board\?\.lastCheck/,
    "the recorded verdict has to be the fallback, ahead of the unchecked list");
  // And it has to be read before the first paint, not after it.
  assert.match(script, /state\.api\("\/api\/circuit"\),\s*\n\s*readBoard\(\)/,
    "the board is read alongside the circuit, so the first draw already knows about it");
});
