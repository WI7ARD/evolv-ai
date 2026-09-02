// Handing the design to something that can make a board.
//
// Everything else here answers questions about a circuit. This one lets you
// stop asking and go and build it: a KiCad netlist is the file Pcbnew reads to
// lay a board out, so this is the door out of the sandbox.
//
// WHAT HAS AND HAS NOT BEEN CHECKED
//
// The structure, the footprints and the pin numbering below were written from
// KiCad's own conventions, and the shape of the file is asserted by tests. They
// have not been opened in KiCad — there is no KiCad in the environment this was
// written in — so this is a careful export rather than a round-tripped one. Two
// things are worth checking on the first board rather than the tenth:
//
//   * Diode and LED pin numbering. This follows KiCad's Device library, where
//     pin 1 is the cathode and pin 2 the anode — which is the opposite way round
//     from how the symbol reads left to right, and is the one mapping here whose
//     convention is not self-evident. Every other part is either symmetrical or
//     obvious.
//   * Footprints are sensible defaults, not choices about your board. A 0805
//     resistor and a 5mm through-hole LED are what most people want and neither
//     is a claim about what you have in a drawer. They are meant to be changed
//     in KiCad, which is where that decision belongs.
//
// The netlist carries components and nets. `libparts` and `libraries` sections
// are deliberately absent: Pcbnew reads the two that are here, and a half-right
// library section would be worse than none — it would describe symbols that do
// not match the ones the file references.

import { createHash } from "node:crypto";
import { PARTS, formatOhms, formatFarads } from "./parts.mjs";
import { isGroundName } from "./netlist.mjs";

export const KICAD_NETLIST_VERSION = "E";

export function kicadError(message, code = "CIRCUIT_EXPORT_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

// Where each part's symbol lives, and what to fit on the board.
//
// Footprints are from the libraries KiCad ships with, so a fresh install
// resolves every one of them without hunting for anything.
const KICAD_PARTS = Object.freeze({
  resistor: { lib: "Device", part: "R", footprint: "Resistor_SMD:R_0805_2012Metric" },
  capacitor: { lib: "Device", part: "C", footprint: "Capacitor_SMD:C_0805_2012Metric" },
  inductor: { lib: "Device", part: "L", footprint: "Inductor_SMD:L_0805_2012Metric" },
  diode: { lib: "Device", part: "D", footprint: "Diode_SMD:D_SOD-123" },
  led: { lib: "Device", part: "LED", footprint: "LED_THT:LED_D5.0mm" },
  rgbled: { lib: "Device", part: "LED_RGB", footprint: "LED_THT:LED_D5.0mm-4_RGB" },
  sevenseg: { lib: "Display_Character", part: "HDSP-7801", footprint: "Display_7Segment:CA56-12SRWA" },
  battery: { lib: "Device", part: "Battery", footprint: "Battery:BatteryHolder_Keystone_1042_1x18650" },
  supply: { lib: "Connector", part: "Conn_01x02_Pin", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
  switch: { lib: "Switch", part: "SW_SPST", footprint: "Button_Switch_THT:SW_PUSH_6mm" },
  potentiometer: { lib: "Device", part: "R_Potentiometer", footprint: "Potentiometer_THT:Potentiometer_Bourns_3386P_Vertical" },
  opamp: { lib: "Amplifier_Operational", part: "LM358", footprint: "Package_DIP:DIP-8_W7.62mm" },
  regulator: { lib: "Regulator_Linear", part: "L7805", footprint: "Package_TO_SOT_THT:TO-220-3_Vertical" },
  gate: { lib: "74xx", part: "74HC00", footprint: "Package_DIP:DIP-14_W7.62mm" },
  flipflop: { lib: "74xx", part: "74HC74", footprint: "Package_DIP:DIP-14_W7.62mm" },
  timer555: { lib: "Timer", part: "NE555P", footprint: "Package_DIP:DIP-8_W7.62mm" },
  mcupin: { lib: "Connector", part: "Conn_01x03_Pin", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical" },
  mcu: { lib: "MCU_Microchip_ATmega", part: "ATmega328P-PU", footprint: "Package_DIP:DIP-28_W7.62mm" },
  motor: { lib: "Motor", part: "Motor_DC", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
  servo: { lib: "Motor", part: "Motor_Servo", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical" },
  buzzer: { lib: "Device", part: "Buzzer", footprint: "Buzzer_Beeper:Buzzer_12x9.5RM7.6" },
  thermistor: { lib: "Device", part: "Thermistor_NTC", footprint: "Resistor_SMD:R_0805_2012Metric" },
  ldr: { lib: "Device", part: "R_PHOTO", footprint: "Opto_LDR:LDR_GL55xx" },
  hall: { lib: "Sensor_Magnetic", part: "A3144", footprint: "Package_TO_SOT_THT:TO-92_Inline" },
  accelerometer: { lib: "Sensor_Motion", part: "ADXL335", footprint: "Package_LGA:LGA-16_4x4mm_P0.65mm" }
});

// Which numbered leg each named pin is, and what kind of pin it is.
//
// KiCad's nodes are numbers; this sandbox's are names, because a name is what a
// person wiring something says. The mapping is the only place the two meet, so
// it is written out in full rather than derived — a rule that produced the
// right answer for eight parts and the wrong one for the ninth would be worse
// than a table, because nothing would say which ninth.
const PIN_NUMBERS = Object.freeze({
  resistor: { a: ["1", "~", "passive"], b: ["2", "~", "passive"] },
  capacitor: { a: ["1", "~", "passive"], b: ["2", "~", "passive"] },
  inductor: { a: ["1", "~", "passive"], b: ["2", "~", "passive"] },
  // Pin 1 is the cathode in KiCad's Device library. See the note at the top:
  // this is the one mapping worth checking against your own KiCad before you
  // order a board, because getting it backwards is expensive and silent.
  diode: { anode: ["2", "A", "passive"], cathode: ["1", "K", "passive"] },
  led: { anode: ["2", "A", "passive"], cathode: ["1", "K", "passive"] },
  rgbled: { common: ["1", "K", "passive"], red: ["2", "A", "passive"], green: ["3", "A", "passive"], blue: ["4", "A", "passive"] },
  battery: { positive: ["1", "+", "power_out"], negative: ["2", "-", "power_out"] },
  supply: { positive: ["1", "+", "power_out"], negative: ["2", "-", "power_out"] },
  switch: { a: ["1", "A", "passive"], b: ["2", "B", "passive"] },
  potentiometer: { a: ["1", "1", "passive"], wiper: ["2", "W", "passive"], b: ["3", "3", "passive"] },
  // An LM358 is two op-amps in one package; this is unit A, and a second op-amp
  // in the same circuit gets its own package rather than the spare half. That
  // is a real choice and the wasteful one — but a netlist that silently shared
  // a package would put two parts where the schematic shows two symbols and one
  // of them would have no footprint.
  opamp: { out: ["1", "~", "output"], inMinus: ["2", "-", "input"], inPlus: ["3", "+", "input"], vNeg: ["4", "V-", "power_in"], vPos: ["8", "V+", "power_in"] },
  regulator: { input: ["1", "VI", "power_in"], ground: ["2", "GND", "power_in"], output: ["3", "VO", "power_out"] },
  gate: { a: ["1", "A", "input"], b: ["2", "B", "input"], out: ["3", "Y", "output"], gnd: ["7", "GND", "power_in"], vcc: ["14", "VCC", "power_in"] },
  // A 74HC74's first flip-flop. Its clear and preset legs (1 and 4) are not in
  // this sandbox's model, so they are not in the netlist either — they are tied
  // high on a real board, and inventing that connection here would be the
  // export making a design decision rather than recording one.
  flipflop: { d: ["2", "D", "input"], clk: ["3", "CLK", "input"], q: ["5", "Q", "output"], qn: ["6", "~Q", "output"], gnd: ["7", "GND", "power_in"], vcc: ["14", "VCC", "power_in"] },
  timer555: { gnd: ["1", "GND", "power_in"], trigger: ["2", "TR", "input"], out: ["3", "Q", "output"], reset: ["4", "R", "input"], control: ["5", "CV", "input"], threshold: ["6", "THR", "input"], discharge: ["7", "DIS", "output"], vcc: ["8", "VCC", "power_in"] },
  mcupin: { pin: ["1", "~", "passive"], vcc: ["2", "+", "power_in"], gnd: ["3", "-", "power_in"] },
  // An ATmega328P in a DIP-28, which is what this sandbox's generic
  // microcontroller most resembles: d0–d7 are PD0–PD7 and a0–a3 are PC0–PC3.
  mcu: {
    d0: ["2", "PD0", "bidirectional"], d1: ["3", "PD1", "bidirectional"], d2: ["4", "PD2", "bidirectional"],
    d3: ["5", "PD3", "bidirectional"], d4: ["6", "PD4", "bidirectional"], d5: ["11", "PD5", "bidirectional"],
    d6: ["12", "PD6", "bidirectional"], d7: ["13", "PD7", "bidirectional"],
    a0: ["23", "PC0", "bidirectional"], a1: ["24", "PC1", "bidirectional"], a2: ["25", "PC2", "bidirectional"], a3: ["26", "PC3", "bidirectional"],
    vcc: ["7", "VCC", "power_in"], gnd: ["8", "GND", "power_in"]
  },
  motor: { positive: ["1", "+", "passive"], negative: ["2", "-", "passive"] },
  servo: { signal: ["1", "PWM", "input"], vcc: ["2", "V+", "power_in"], gnd: ["3", "GND", "power_in"] },
  buzzer: { a: ["1", "+", "passive"], b: ["2", "-", "passive"] },
  sevenseg: { common: ["3", "CC", "passive"], a: ["7", "A", "passive"], b: ["6", "B", "passive"], c: ["4", "C", "passive"], d: ["2", "D", "passive"], e: ["1", "E", "passive"], f: ["9", "F", "passive"], g: ["10", "G", "passive"], dp: ["5", "DP", "passive"] },
  thermistor: { a: ["1", "~", "passive"], b: ["2", "~", "passive"] },
  ldr: { a: ["1", "~", "passive"], b: ["2", "~", "passive"] },
  hall: { out: ["3", "OUT", "open_collector"], vcc: ["1", "VCC", "power_in"], gnd: ["2", "GND", "power_in"] },
  accelerometer: { x: ["10", "XOUT", "output"], y: ["9", "YOUT", "output"], z: ["8", "ZOUT", "output"], vcc: ["13", "VS", "power_in"], gnd: ["15", "GND", "power_in"] }
});

// A ground symbol is not a part.
//
// It is a label saying "this net is the reference", and putting it in the
// netlist as a component would put a footprint on the board for something that
// does not physically exist — and in the bill of materials for something nobody
// can order.
const NOT_A_PART = new Set(["ground"]);

// What KiCad writes in the value field: what a schematic prints next to the
// symbol, which is the number and not the sentence. "330" rather than "330Ω
// resistor", because the designator beside it already says it is a resistor.
export function kicadValue(component) {
  const { kind, values = {} } = component;
  switch (kind) {
    case "resistor": case "potentiometer": case "thermistor": case "ldr":
      return formatOhms(values.ohms).replace("Ω", "");
    case "capacitor": return formatFarads(values.farads).replace("F", "");
    case "inductor": return `${values.henries >= 1e-3 ? `${values.henries * 1e3}m` : `${values.henries * 1e6}u`}H`;
    case "led": case "rgbled": return String(values.colour || "red");
    case "diode": return String(values.part || "1N4148");
    case "battery": case "supply": return `${values.volts ?? 5}V`;
    case "opamp": case "regulator": case "gate": case "flipflop":
      return String(values.part || values.function || KICAD_PARTS[kind].part);
    case "mcu": return KICAD_PARTS.mcu.part;
    default: return KICAD_PARTS[kind]?.part || kind;
  }
}

// A stable identity for a part, derived from its designator.
//
// KiCad matches a component on the board to one in the netlist by this, so it
// has to be the same every time the same circuit is exported. A fresh random id
// each export would make Pcbnew tear the board up and lay it out again, losing
// every placement decision anyone had made.
function stableUuid(reference) {
  const hex = createHash("sha1").update(`evolv-circuit:${reference}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The same trim the download filename gets, so the two agree.
export const safeName = (value) =>
  String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "circuit";

const quote = (value) => `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The parts that go on a board, in the order a parts list is read.
export function exportableComponents(components) {
  return components
    .filter((component) => !NOT_A_PART.has(component.kind))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
}

// Anything the export cannot answer for, said before the file is written rather
// than discovered in KiCad.
export function exportProblems(components) {
  const problems = [];
  for (const component of exportableComponents(components)) {
    if (!KICAD_PARTS[component.kind]) {
      problems.push(`${component.id} is a ${component.kind}, which has no KiCad symbol here.`);
      continue;
    }
    const pins = PIN_NUMBERS[component.kind] || {};
    for (const pin of Object.keys(component.pins || {})) {
      if (!pins[pin]) problems.push(`${component.id} has a pin called ${pin} with no numbered leg to match it.`);
    }
  }
  return problems;
}

// The netlist itself.
export function toKicadNetlist(components, { name = "Evolv circuit", date = new Date() } = {}) {
  if (!Array.isArray(components) || !components.length) {
    throw kicadError("There is nothing to export — the circuit is empty.", "CIRCUIT_EMPTY");
  }
  const problems = exportProblems(components);
  if (problems.length) {
    throw kicadError(`This circuit cannot be exported yet. ${problems.join(" ")}`, "CIRCUIT_EXPORT_UNSUPPORTED");
  }
  const parts = exportableComponents(components);

  // Nets, in the order KiCad numbers them: from 1, in the order they are first
  // mentioned, with the ground nets kept as they were named. A net with one
  // thing on it is still a net — the export is not the place to argue about
  // whether the circuit is finished.
  const nets = new Map();
  for (const component of parts) {
    for (const [pin, net] of Object.entries(component.pins || {})) {
      if (!net) continue;
      if (!nets.has(net)) nets.set(net, []);
      const [number, fn, type] = PIN_NUMBERS[component.kind][pin];
      nets.get(net).push({ ref: component.id, pin: number, fn, type });
    }
  }

  const stamp = date.toISOString().replace("T", " ").slice(0, 19);
  const lines = [];
  lines.push(`(export (version ${quote(KICAD_NETLIST_VERSION)})`);
  lines.push("  (design");
  // Named the way the file on disk is named, not the way the title reads. The
  // two are the same document and a mismatch is one more thing to reconcile.
  lines.push(`    (source ${quote(`${safeName(name)}.kicad_sch`)})`);
  lines.push(`    (date ${quote(stamp)})`);
  lines.push(`    (tool ${quote("Evolv Circuit")})`);
  lines.push("    (sheet (number \"1\") (name \"/\") (tstamps \"/\")");
  lines.push("      (title_block");
  lines.push(`        (title ${quote(name)})`);
  lines.push(`        (date ${quote(stamp.slice(0, 10))})`);
  lines.push("        (rev \"\")");
  lines.push("        (company \"\"))))");

  lines.push("  (components");
  for (const component of parts) {
    const symbol = KICAD_PARTS[component.kind];
    lines.push(`    (comp (ref ${quote(component.id)})`);
    lines.push(`      (value ${quote(kicadValue(component))})`);
    lines.push(`      (footprint ${quote(symbol.footprint)})`);
    lines.push(`      (datasheet ${quote("~")})`);
    lines.push(`      (libsource (lib ${quote(symbol.lib)}) (part ${quote(symbol.part)}) (description ${quote(PARTS[component.kind]?.label || component.kind)}))`);
    lines.push(`      (property (name "Sheetname") (value "/"))`);
    lines.push(`      (sheetpath (names "/") (tstamps "/"))`);
    lines.push(`      (tstamps ${quote(stableUuid(component.id))}))`);
  }
  lines.push("  )");

  lines.push("  (nets");
  let code = 0;
  for (const [net, nodes] of nets) {
    code += 1;
    // KiCad prefixes a net with the sheet it belongs to; a global power net
    // has no sheet, so it is written bare. Prefixing ground with "/" would
    // describe it as local to a sheet, which for the one net that has to be
    // common to everything is the wrong claim to make.
    const label = isGroundName(net) ? net : `/${net}`;
    lines.push(`    (net (code ${quote(String(code))}) (name ${quote(label)})`);
    for (const node of nodes) {
      lines.push(`      (node (ref ${quote(node.ref)}) (pin ${quote(node.pin)}) (pinfunction ${quote(node.fn)}) (pintype ${quote(node.type)}))`);
    }
    lines.push("    )");
  }
  lines.push("  )");
  lines.push(")");
  return `${lines.join("\n")}\n`;
}

// The other half of building something: what to order.
//
// A netlist says how the parts connect; it does not say how many of each to
// buy. This is the same bill of materials the sandbox already shows, as a file
// a supplier's upload form will accept.
export function toBomCsv(components, billOfMaterials) {
  const rows = [["Reference", "Quantity", "Value", "Description", "Footprint"]];
  for (const line of billOfMaterials) {
    const first = components.find((component) => component.id === line.references[0]);
    rows.push([
      line.references.join(" "),
      String(line.quantity),
      first ? kicadValue(first) : "",
      line.description,
      first ? (KICAD_PARTS[first.kind]?.footprint || "") : ""
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export { KICAD_PARTS, PIN_NUMBERS };
