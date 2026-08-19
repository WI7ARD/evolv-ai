import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CircuitService, CIRCUIT_VERSION } from "../lib/circuit.mjs";
import { createDatabase } from "../lib/database.mjs";
import { handleCircuitRoutes } from "../server/circuit-routes.mjs";
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
  const sent = [];
  const json = (res, status, payload) => sent.push({ status, payload });
  const call = (method, pathname, body) => handleCircuitRoutes({
    req: { method },
    res: {},
    url: new URL(`http://local${pathname}`),
    readBody: async () => body,
    bodyLimit: 1_000_000,
    json,
    circuitService,
    database
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

    // Saved and reloaded through the database, which never sees inside the
    // snapshot — the service holds no database handle, which is what keeps its
    // tools in the automatic risk tier.
    await call("POST", "/api/circuit/circuits", { name: "LED test" });
    const saved = sent.at(-1).payload;
    assert.equal(saved.partCount, 4);

    await call("DELETE", "/api/circuit");
    await call("GET", "/api/circuit");
    assert.equal(sent.at(-1).payload.counts.parts, 0);

    await call("POST", `/api/circuit/circuits/${saved.id}/load`);
    assert.equal(sent.at(-1).payload.circuit.counts.parts, 4);
    assert.equal(sent.at(-1).payload.name, "LED test");

    // An unavailable service is a 503 rather than a crash, matching physics.
    await assert.rejects(() => handleCircuitRoutes({
      req: { method: "GET" }, res: {}, url: new URL("http://local/api/circuit"),
      readBody: async () => ({}), bodyLimit: 1, json, circuitService: null, database
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
