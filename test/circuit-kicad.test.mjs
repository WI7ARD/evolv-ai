import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  toKicadNetlist, toBomCsv, kicadValue, exportProblems, exportableComponents, KICAD_PARTS, PIN_NUMBERS
} from "../lib/circuit/kicad.mjs";
import { PART_KINDS, PARTS } from "../lib/circuit/parts.mjs";
import { CircuitService } from "../lib/circuit.mjs";
import { handleCircuitRoutes } from "../server/circuit-routes.mjs";
import { BenchService } from "../lib/bench.mjs";
import { createDatabase } from "../lib/database.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// This export has not been opened in KiCad — there is none in this environment —
// so these tests check the two things that can be checked without it: that the
// file has the structure KiCad's netlist format defines, and that every part in
// the catalogue can answer for itself. What they cannot check is whether a
// footprint is the one you wanted, which is a decision rather than a fact.

const board = () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 330, pins: { a: "VCC", b: "N1" } });
  service.apply("add", { kind: "led", colour: "green", pins: { anode: "N1", cathode: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  return service;
};

// A tiny reader, because asserting on a netlist with string matching would pass
// for a file that is nearly the right shape, and nearly is not a file format.
function readSExpression(text) {
  let at = 0;
  const parse = () => {
    while (/\s/.test(text[at])) at += 1;
    if (text[at] === "(") {
      at += 1;
      const list = [];
      for (;;) {
        while (/\s/.test(text[at])) at += 1;
        if (text[at] === ")") { at += 1; return list; }
        if (at >= text.length) throw new Error("unbalanced parentheses");
        list.push(parse());
      }
    }
    if (text[at] === '"') {
      at += 1;
      let value = "";
      while (text[at] !== '"') {
        if (text[at] === "\\") at += 1;
        value += text[at];
        at += 1;
      }
      at += 1;
      return value;
    }
    let atom = "";
    while (at < text.length && !/[\s()]/.test(text[at])) { atom += text[at]; at += 1; }
    return atom;
  };
  return parse();
}
const section = (tree, name) => tree.find((node) => Array.isArray(node) && node[0] === name);

test("the netlist parses as the s-expression KiCad's format is", () => {
  const netlist = toKicadNetlist(board().snapshot().components, { name: "Blinker" });
  const tree = readSExpression(netlist);
  assert.equal(tree[0], "export");
  assert.deepEqual(section(tree, "version"), ["version", "E"]);

  const design = section(tree, "design");
  assert.deepEqual(section(design, "tool"), ["tool", "Evolv circuit sandbox"]);
  assert.deepEqual(section(design, "source"), ["source", "Blinker.kicad_sch"]);

  const components = section(tree, "components").slice(1);
  const nets = section(tree, "nets").slice(1);
  assert.ok(components.length >= 3 && nets.length >= 2);
  // Balanced parentheses all the way to the end, which the reader above proves
  // by not throwing, and nothing trailing after the closing bracket.
  assert.match(netlist.trimEnd().slice(-1), /\)/);
});

test("a ground symbol is a label, not something to solder", () => {
  // Exported as a component it would put a footprint on the board for a thing
  // that does not physically exist, and a line in the parts list nobody can
  // order.
  const components = board().snapshot().components;
  assert.ok(components.some((component) => component.kind === "ground"), "the circuit does have one");
  assert.equal(exportableComponents(components).some((component) => component.kind === "ground"), false);

  const tree = readSExpression(toKicadNetlist(components));
  const refs = section(tree, "components").slice(1).map((comp) => section(comp, "ref")[1]);
  assert.deepEqual(refs, ["D1", "PS1", "R1"], "and it is not among the parts");
  // But the net it named is still there, and is written bare rather than as a
  // local sheet net, because ground is common to everything.
  const names = section(tree, "nets").slice(1).map((net) => section(net, "name")[1]);
  assert.ok(names.includes("GND"), `expected a bare GND net, got ${names.join(", ")}`);
  assert.ok(names.includes("/N1"), "and ordinary nets keep their sheet prefix");
});

test("every part carries a reference, a value, and a footprint", () => {
  // A netlist without footprints imports into Pcbnew as a list of parts with
  // nothing to place, which is the same as not exporting at all.
  const service = new CircuitService();
  for (const kind of PART_KINDS) service.apply("add", { kind });
  const components = service.snapshot().components;
  assert.deepEqual(exportProblems(components), [], "every kind in the catalogue must be exportable");

  const tree = readSExpression(toKicadNetlist(components));
  for (const comp of section(tree, "components").slice(1)) {
    const ref = section(comp, "ref")[1];
    assert.match(ref, /^[A-Z]+[0-9]+$/, `${ref} is not a designator`);
    assert.ok(section(comp, "value")[1], `${ref} has no value`);
    const footprint = section(comp, "footprint")[1];
    assert.match(footprint, /^[A-Za-z0-9_.]+:[A-Za-z0-9_.\-+]+$/, `${ref} has footprint "${footprint}"`);
    const libsource = section(comp, "libsource");
    assert.ok(section(libsource, "lib")[1] && section(libsource, "part")[1], `${ref} has no symbol`);
  }
});

test("every pin the sandbox knows has a numbered leg, and no two share one", () => {
  // The mapping between named pins and numbered legs is where this sandbox and
  // KiCad meet, and a wrong number is a wrong board — silently, and only
  // discovered after it is made.
  for (const kind of PART_KINDS) {
    if (kind === "ground") continue;
    const pins = PIN_NUMBERS[kind];
    assert.ok(pins, `${kind} has no pin numbering`);
    for (const pin of PARTS[kind].pins) {
      assert.ok(pins[pin], `${kind} pin "${pin}" has no numbered leg`);
      const [number, fn, type] = pins[pin];
      assert.match(number, /^[0-9]+$/, `${kind}.${pin} is leg "${number}"`);
      assert.ok(fn && type, `${kind}.${pin} needs a function and a type`);
    }
    const numbers = PARTS[kind].pins.map((pin) => pins[pin][0]);
    assert.equal(new Set(numbers).size, numbers.length, `${kind} puts two pins on one leg: ${numbers.join(", ")}`);
  }
  // The one convention that is not self-evident, asserted so that if it is ever
  // changed it is changed deliberately: pin 1 is the cathode.
  assert.equal(PIN_NUMBERS.led.cathode[0], "1");
  assert.equal(PIN_NUMBERS.led.anode[0], "2");
  assert.equal(PIN_NUMBERS.diode.cathode[0], "1");
});

test("the same circuit exports the same identities every time", () => {
  // KiCad matches a part on the board to one in the netlist by its timestamp
  // id. A fresh random one each export makes Pcbnew treat every part as new and
  // tear up a layout somebody spent an evening on.
  const components = board().snapshot().components;
  const first = toKicadNetlist(components, { date: new Date("2026-01-01T00:00:00Z") });
  const again = toKicadNetlist(components, { date: new Date("2026-06-01T00:00:00Z") });
  const ids = (text) => section(readSExpression(text), "components").slice(1)
    .map((comp) => `${section(comp, "ref")[1]}:${section(comp, "tstamps")[1]}`);
  assert.deepEqual(ids(first), ids(again), "the ids must not depend on when it was exported");
  assert.ok(ids(first).every((entry) => /[0-9a-f]{8}-[0-9a-f]{4}-/.test(entry)), "and they have to look like ids");
});

test("values read the way a schematic prints them", () => {
  assert.equal(kicadValue({ kind: "resistor", values: { ohms: 330 } }), "330");
  assert.equal(kicadValue({ kind: "resistor", values: { ohms: 10_000 } }), "10k");
  assert.equal(kicadValue({ kind: "capacitor", values: { farads: 1e-7 } }), "100n");
  assert.equal(kicadValue({ kind: "supply", values: { volts: 5 } }), "5V");
  // Not "330Ω resistor" — the designator beside it already says it is one.
  assert.doesNotMatch(kicadValue({ kind: "resistor", values: { ohms: 330 } }), /resistor/);
});

test("a part the export cannot answer for is named before the file is written", () => {
  // Rather than emitting a netlist with a hole in it, which would be discovered
  // in KiCad as a part with no symbol and no clue where it came from.
  const strange = [{ id: "X1", kind: "flux-capacitor", values: {}, pins: { a: "A", b: "B" } }];
  assert.throws(() => toKicadNetlist(strange), (error) => {
    assert.equal(error.code, "CIRCUIT_EXPORT_UNSUPPORTED");
    assert.match(error.message, /X1 is a flux-capacitor/);
    return true;
  });
  assert.throws(() => toKicadNetlist([]), (error) => error.code === "CIRCUIT_EMPTY");
});

test("the parts list is a CSV a supplier's form will take", () => {
  const service = board();
  const csv = toBomCsv(service.snapshot().components, service.perceive().billOfMaterials);
  const rows = csv.trim().split("\n");
  assert.equal(rows[0], "Reference,Quantity,Value,Description,Footprint");
  assert.ok(rows.length >= 4, `expected a row per part, got ${rows.length - 1}`);
  // Every row has the same number of fields, which is what "a CSV" means and is
  // exactly what a description containing a comma would break.
  const fields = (row) => row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).length;
  for (const row of rows) assert.equal(fields(row), fields(rows[0]), `ragged row: ${row}`);
  assert.ok(!csv.includes("GND1"), "and a ground is not something to order");
});

test("the export is reachable as a download, and the page asks for one", async () => {
  // Served as a file rather than as JSON, because the point of it is to land in
  // a folder KiCad opens.
  const circuitService = board();
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-kicad-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "k.db"), defaultPrompt: "test" });
  const bench = new BenchService({ database, circuitService });
  const saved = bench.save({ name: "Bike telemetry", intent: "Log speed once a second" });
  const written = { head: null, body: "" };
  await handleCircuitRoutes({
    req: { method: "GET" },
    res: {
      writeHead: (status, headers) => { written.head = { status, headers }; },
      end: (body) => { written.body = body; }
    },
    url: new URL("http://local/api/circuit/export?format=netlist&name=Bike%20telemetry"),
    readBody: async () => ({}),
    bodyLimit: 1_000_000,
    json: () => { throw new Error("an export must not answer with JSON"); },
    circuitService,
    bench
  });
  assert.equal(written.head.status, 200);
  assert.match(written.head.headers["content-disposition"], /attachment; filename="Bike-telemetry\.net"/);
  assert.match(written.body, /^\(export \(version "E"\)/);

  const bom = { head: null, body: "" };
  await handleCircuitRoutes({
    req: { method: "GET" },
    res: { writeHead: (status, headers) => { bom.head = { status, headers }; }, end: (body) => { bom.body = body; } },
    url: new URL("http://local/api/circuit/export?format=bom"),
    readBody: async () => ({}), bodyLimit: 1_000_000,
    json: () => { throw new Error("an export must not answer with JSON"); },
    circuitService, bench
  });
  assert.match(bom.head.headers["content-type"], /text\/csv/);
  assert.match(bom.body, /^Reference,Quantity/);

  // Exporting wrote itself into the board's history. Nobody pressed a second
  // button to make that happen, which is the only way a history stays complete.
  const exported = bench.get(saved.id).stages.find((stage) => stage.id === "export");
  assert.equal(exported.state, "done");
  assert.equal(exported.headline, "Bike-telemetry-bom.csv");

  // And it goes stale the moment the design it described changes.
  circuitService.apply("add", { kind: "resistor", ohms: 470, pins: { a: "VCC", b: "GND" } });
  const stale = bench.get(saved.id).stages.find((stage) => stage.id === "export");
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.changed, ["components"]);

  database.close();
  await rm(directory, { recursive: true, force: true });

  // And the page has something to press, which goes through that route.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(markup, /id="circuit-export"/);
  assert.match(markup, /id="circuit-bom"/);
  assert.match(script, /\/api\/circuit\/export\?format=/);
  // A download, not a navigation: opening the URL would work in a browser and
  // in Electron would take the person away from the page they were working on.
  assert.match(script, /link\.download = filename/);
});

test("every footprint names a library KiCad ships with", () => {
  // Not a check that the footprint exists — that needs KiCad — but that each is
  // written as library:footprint against one of the standard libraries, so a
  // fresh install resolves it rather than sending someone hunting.
  const known = new Set([
    "Resistor_SMD", "Capacitor_SMD", "Inductor_SMD", "Diode_SMD", "LED_THT", "Display_7Segment",
    "Battery", "Connector_PinHeader_2.54mm", "Button_Switch_THT", "Potentiometer_THT",
    "Package_DIP", "Package_TO_SOT_THT", "Package_LGA", "Buzzer_Beeper", "Opto_LDR"
  ]);
  for (const [kind, symbol] of Object.entries(KICAD_PARTS)) {
    const [library] = symbol.footprint.split(":");
    assert.ok(known.has(library), `${kind} uses footprint library ${library}, which is not a standard one`);
  }
});

test("no two elements on the page answer to the same id", async () => {
  // The export button was given id="circuit-bom", which the bill of materials
  // container already had. querySelector returns the first match in document
  // order, so the draw pass wrote the parts table *into the button* — the
  // toolbar grew a table where a label should be, and the real BOM stayed
  // empty. Both the download and every test still passed; it took looking at
  // the page.
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual([...new Set(duplicates)], [], "these ids are used more than once");
});
