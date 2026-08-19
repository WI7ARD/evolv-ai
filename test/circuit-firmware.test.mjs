import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse, tokenize, Firmware, FirmwareError } from "../lib/circuit/firmware.mjs";
import { Mcu, pinName, mcuPinNames, PWM_HZ } from "../lib/circuit/mcu.mjs";
import { runTransient } from "../lib/circuit/transient.mjs";
import { createMcus } from "../lib/circuit/mcu.mjs";
import { CircuitService } from "../lib/circuit.mjs";

// Firmware is the first thing in Evolv that runs code the AI wrote, so the
// first tests here are about what it cannot do, not what it can.

const GROUND = { id: "GND1", kind: "ground", values: {}, pins: { pin: "GND" } };
const blinker = (source, dt = 2e-4) => {
  const parts = [
    { id: "PS1", kind: "supply", values: { volts: 5, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" } },
    { id: "U1", kind: "mcu", values: {}, pins: { d0: "IO", a0: "SENSE", vcc: "VCC", gnd: "GND" } },
    { id: "R1", kind: "resistor", values: { ohms: 330 }, pins: { a: "IO", b: "N1" } },
    { id: "D1", kind: "led", values: { colour: "red" }, pins: { anode: "N1", cathode: "GND" } },
    { id: "R2", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "VCC", b: "SENSE" } },
    { id: "R3", kind: "resistor", values: { ohms: 10_000 }, pins: { a: "SENSE", b: "GND" } },
    GROUND
  ];
  const mcus = createMcus(parts, new Map([["U1", source]]));
  return { parts, mcus, run: (seconds) => runTransient(parts, {
    seconds, dt, mcus, probes: [{ kind: "net", target: "IO" }, { kind: "part", target: "D1" }]
  }) };
};

test("firmware cannot reach anything outside itself, because it cannot name it", () => {
  // Not a blocklist. The interpreter resolves a call against the functions the
  // program declared and a fixed list of built-ins; there is no outer scope to
  // fall through to, so there is nothing to escape into.
  for (const attempt of [
    'function loop(){ require("fs"); }',
    "function loop(){ process.exit(); }",
    'function loop(){ eval("1"); }',
    "function loop(){ globalThis.x = 1; }",
    'function loop(){ fetch("http://elsewhere"); }',
    "function loop(){ constructor(); }"
  ]) {
    const chip = new Mcu({ id: "U1", values: {} });
    let failure = null;
    try {
      chip.load(attempt);
      chip.observe((pin) => (pin === "vcc" ? 5 : 0));
      for (let step = 0; step < 20 && !chip.error; step += 1) chip.advance(1e-4);
      failure = chip.error;
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${attempt} should not have run`);
    assert.match(String(failure.code), /FIRMWARE_/, `${attempt} failed with ${failure.code}`);
  }
});

test("nothing in the codebase evaluates firmware as code", async () => {
  // The stance this whole design exists to keep. If any of these ever appear,
  // the argument above stops being true and this test is where that is noticed.
  for (const file of ["firmware.mjs", "mcu.mjs"]) {
    const source = await readFile(new URL(`../lib/circuit/${file}`, import.meta.url), "utf8");
    const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    for (const forbidden of ["eval(", "new Function", "node:vm", "require("]) {
      assert.ok(!code.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
});

test("a blink sketch produces the period the arithmetic says", () => {
  const { run } = blinker(`
    function setup() { pinMode(0, 1); }
    function loop() { digitalWrite(0, 1); delay(100); digitalWrite(0, 0); delay(100); }
  `);
  const result = run(0.5);
  const rising = [];
  let wasHigh = false;
  for (const [time, value] of result.traces[0].points) {
    const isHigh = value > 2.5;
    if (isHigh && !wasHigh) rising.push(time);
    wasHigh = isHigh;
  }
  assert.ok(rising.length >= 2, `expected the LED to blink, saw ${rising.length} edges`);
  const periods = rising.slice(1).map((time, index) => time - rising[index]);
  const mean = periods.reduce((total, value) => total + value, 0) / periods.length;
  assert.ok(Math.abs(mean - 0.2) < 0.01, `100ms on and 100ms off is a 200ms period, got ${(mean * 1000).toFixed(1)}ms`);
  // And it is a real LED on the end of it, drawing a real current.
  assert.ok(Math.max(...result.traces[1].points.map(([, value]) => value)) > 0.005, "the LED should actually light");
});

test("delay costs simulated time, and millis agrees with it", () => {
  const { run, mcus } = blinker(`
    function setup() { print("start", millis()); }
    function loop() { delay(50); print("tick", millis()); }
  `);
  run(0.22);
  const output = mcus.get("U1").view().output;
  assert.equal(output[0].line, "start 0");
  // Every tick fifty milliseconds apart, because delay is honest.
  const ticks = output.filter((entry) => entry.line.startsWith("tick"));
  assert.ok(ticks.length >= 3, `expected several ticks, got ${ticks.length}`);
  for (const [index, tick] of ticks.entries()) {
    const expected = (index + 1) * 50;
    const reported = Number(tick.line.split(" ")[1]);
    assert.ok(Math.abs(reported - expected) <= 2, `tick ${index} should read about ${expected}ms, read ${reported}`);
  }
});

test("a busy loop is genuinely slow, which is the lesson", () => {
  // No delay at all: the loop runs as fast as the clock allows and no faster.
  // A model where firmware is free would run it an unbounded number of times
  // per timestep and teach the opposite of what a real board teaches.
  const { run, mcus } = blinker(`
    function loop() { var total = 0; for (var i = 0; i < 200; i++) { total = total + i; } }
  `);
  run(0.02);
  const chip = mcus.get("U1");
  const iterations = chip.view().iterations;
  // 200 iterations of a few cycles each, at 16MHz, in 20ms — hundreds of passes,
  // not hundreds of thousands and not two.
  assert.ok(iterations > 10, `expected the loop to make real progress, got ${iterations}`);
  assert.ok(iterations < 20_000, `and to cost something, got ${iterations}`);
});

test("an analogRead is expensive, and the price is visible", () => {
  // A successive-approximation ADC takes far longer than a pin write. Someone
  // reading six sensors in a tight loop should find out here rather than on a
  // bench wondering why their loop rate collapsed.
  const busy = blinker("function loop() { var x = 1; }");
  const reading = blinker("function loop() { analogRead(8); }");
  busy.run(0.02);
  reading.run(0.02);
  const fast = busy.mcus.get("U1").view().iterations;
  const slow = reading.mcus.get("U1").view().iterations;
  assert.ok(slow < fast / 10, `an ADC read should dominate the loop (${fast} vs ${slow} iterations)`);
});

test("analogRead reads the voltage that is really there", () => {
  // A divider of two equal resistors puts half the supply on the pin, which is
  // 511 or 512 of 1023. The quantisation is real and worth meeting here.
  const { run, mcus } = blinker(`
    function loop() { print("adc", analogRead(8)); delay(10); }
  `);
  run(0.05);
  const readings = mcus.get("U1").view().output
    .filter((entry) => entry.line.startsWith("adc"))
    .map((entry) => Number(entry.line.split(" ")[1]));
  assert.ok(readings.length > 0, "the firmware should have read something");
  for (const reading of readings) {
    assert.ok(Math.abs(reading - 511) < 15, `half the supply is about 511 of 1023, got ${reading}`);
  }
});

test("digitalRead answers about the pin, not about what was written to it", () => {
  // A pin set high but held low by the circuit reads low. That is how you find
  // a short with a print statement, and a model that echoed the last write back
  // would hide exactly the fault worth finding.
  const parts = [
    { id: "PS1", kind: "supply", values: { volts: 5, resistance: 0.05 }, pins: { positive: "VCC", negative: "GND" } },
    { id: "U1", kind: "mcu", values: {}, pins: { d0: "GND", vcc: "VCC", gnd: "GND" } },
    GROUND
  ];
  const mcus = createMcus(parts, new Map([["U1", `
    function setup() { pinMode(0, 1); digitalWrite(0, 1); }
    function loop() { print("pin", digitalRead(0)); delay(10); }
  `]]));
  runTransient(parts, { seconds: 0.05, dt: 2e-4, mcus });
  const readings = mcus.get("U1").view().output.map((entry) => entry.line);
  assert.ok(readings.length > 0);
  assert.ok(readings.every((line) => line === "pin 0"),
    `a pin shorted to ground reads low however hard it is driven, got ${readings[0]}`);
});

test("analogWrite makes a real square wave, not an average", () => {
  // The hardware switches the pin; the firmware never knows. A model that drove
  // the average would make a PWM-dimmed LED impossible to study and a
  // PWM-driven servo impossible at all.
  const { run } = blinker(`
    function setup() { analogWrite(0, 64); }
    function loop() { delay(100); }
  `, 2e-5);
  const result = run(0.05);
  const values = result.traces[0].points.map(([, value]) => value);
  const high = values.filter((value) => value > 2.5).length;
  assert.ok(high > 0 && high < values.length, "the pin must actually switch, not sit at a level");
  // 64 of 255 is a quarter, give or take where the samples land.
  const duty = high / values.length;
  assert.ok(Math.abs(duty - 0.25) < 0.08, `expected about a quarter duty, measured ${duty.toFixed(3)}`);
  assert.ok(PWM_HZ > 100, "and at a rate an LED looks steady at");
});

test("the language reports its mistakes with a line number", () => {
  const cases = [
    ["function loop() { digitalWrite(0 }", /Expected \)/],
    ["function loop() { var x = ; }", /does not understand/],
    ["function loop() { x = y + 1; }", /has not been given a value/],
    ["function loop() { var x = 1 / 0; }", /Divided by zero/],
    ["var x = 1;", /needs a setup\(\) or a loop\(\)/]
  ];
  for (const [source, expected] of cases) {
    let failure = null;
    try {
      const chip = new Mcu({ id: "U1", values: {} });
      chip.load(source);
      chip.observe((pin) => (pin === "vcc" ? 5 : 0));
      for (let step = 0; step < 10 && !chip.error; step += 1) chip.advance(1e-4);
      failure = chip.error;
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${source} should have failed`);
    assert.match(failure.message, expected, `got: ${failure.message}`);
  }
});

test("an infinite loop in setup is reported rather than hanging anything", () => {
  // A real board with this firmware looks identical to a dead one. The
  // interpreter cannot hang — it only ever gets the cycles a timestep is worth —
  // so the useful thing is noticing that loop() is never coming round.
  const chip = new Mcu({ id: "U1", values: {} });
  chip.load("function setup() { while (1) { var x = 1; } } function loop() { }");
  chip.observe((pin) => (pin === "vcc" ? 5 : 0));
  let starved = 0;
  for (let step = 0; step < 50; step += 1) starved = chip.advance(1e-4).starved || 0;
  assert.ok(starved > 20, `a stuck program should be noticed, starved count was ${starved}`);
  assert.equal(chip.view().iterations, 0, "and loop() never ran");
});

test("pin numbers map onto real legs, and nothing else does", () => {
  assert.equal(pinName(0), "d0");
  assert.equal(pinName(7), "d7");
  assert.equal(pinName(8), "a0");
  assert.equal(pinName(11), "a3");
  assert.equal(pinName(12), "", "there is no pin 12 and pretending otherwise would be a silent lie");
  assert.equal(pinName(-1), "");
  assert.equal(mcuPinNames().length, 12);
});

test("the parser accepts the shapes the tool description promises", () => {
  // Anything the description tells a model it can write, it must be able to
  // write. A tool that documents a feature it does not have is worse than one
  // that documents nothing.
  const source = `
    var counter = 0;
    function double(value) { return value * 2; }
    function setup() {
      pinMode(0, 1);
      pinMode(1, 2);
    }
    function loop() {
      var i = 0;
      while (i < 3) { i++; }
      for (var j = 0; j < 3; j = j + 1) { if (j == 1) { continue; } counter += double(j); }
      if (counter > 10 && counter < 100) { print("mid", counter); } else { print("out"); }
      var level = map(analogRead(8), 0, 1023, 0, 255);
      analogWrite(0, constrain(level, 0, 255));
      delayMicroseconds(500);
    }
  `;
  assert.doesNotThrow(() => parse(source));
  const { functions } = parse(source);
  assert.deepEqual([...functions.keys()].sort(), ["double", "loop", "setup"]);
  assert.ok(tokenize("// a comment\n/* another */ var x = 1;").length > 0);
});

test("firmware is saved with the circuit and comes back with it", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "IO", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  const source = "function setup() { pinMode(0, 1); }\nfunction loop() { digitalWrite(0, 1); }";
  service.apply("firmware", { id: "U1", source });

  const snapshot = service.snapshot();
  assert.equal(snapshot.firmware.U1, source, "the firmware is part of what was built");

  const reopened = new CircuitService();
  reopened.restore(snapshot);
  assert.equal(reopened.readFirmware("U1").source, source);
  assert.equal(reopened.perceive().elapsedSeconds, 0, "and it reopens not yet run");
});

test("firmware is refused where there is no chip to run it", () => {
  const service = new CircuitService();
  service.apply("add", { kind: "resistor", ohms: 1_000, pins: { a: "A", b: "B" } });
  assert.throws(() => service.apply("firmware", { id: "R1", source: "function loop(){}" }), (error) => {
    assert.equal(error.code, "CIRCUIT_NOT_MCU");
    assert.match(error.message, /not a microcontroller/);
    return true;
  });
  // And a syntax error is reported where it was written, not later as a chip
  // that mysteriously does nothing.
  service.apply("add", { kind: "mcu", pins: { vcc: "VCC", gnd: "GND" } });
  assert.throws(() => service.apply("firmware", { id: "U1", source: "function loop() {" }), (error) => {
    assert.match(String(error.code), /FIRMWARE_/);
    return true;
  });
});

test("what a chip is doing is on the page, and the page still computes nothing", async () => {
  // Every stage so far has had a fault that only a screenshot found, and every
  // one of them was in the joins: the frame carried a number the page never
  // read, or the page read one the frame never sent. So this test walks the
  // same join — the container exists in the markup, the draw pass fills it, and
  // the fields it reads are fields the server actually sends.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(markup, /id="circuit-mcus"/, "the panel needs somewhere to go");
  assert.match(script, /\$\("#circuit-mcus"\)/, "and the draw pass has to fill it");

  const panel = script.slice(script.indexOf("function renderMcus"), script.indexOf("function renderFindings"));
  for (const field of ["iterations", "output", "clockHz", "error", "pins"]) {
    assert.ok(panel.includes(field), `the panel should show ${field}`);
  }
  // The renderer draws; it does not decide anything. A pin state worked out in
  // the page would be a second answer to a question the interpreter already
  // answered, and the two would drift.
  assert.doesNotMatch(panel, /new Mcu|Firmware|analogRead|1023/, "the page must not interpret anything");

  // And the frame really carries all of it, so none of the above reads
  // undefined the first time someone builds a board.
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "IO", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "resistor", ohms: 330, pins: { a: "IO", b: "N1" } });
  service.apply("add", { kind: "led", colour: "red", pins: { anode: "N1", cathode: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("firmware", { id: "U1", source: `
    function setup() { pinMode(0, 1); }
    function loop() { digitalWrite(0, 1); print("on", millis()); delay(20); digitalWrite(0, 0); delay(20); }
  ` });
  service.apply("run", { seconds: 0.1, dt: 2e-4 });

  const chip = service.frame().mcus.U1;
  assert.ok(chip, "the frame has to carry the chip at all");
  assert.equal(chip.error, null);
  assert.ok(chip.iterations >= 2, `loop() should have come round, got ${chip.iterations}`);
  assert.ok(chip.output.length >= 2, "and what it printed should be there to read");
  assert.ok(chip.output.every((entry) => Number.isFinite(entry.at) && typeof entry.line === "string"));
  assert.equal(chip.pins.d0.mode, "output");
  assert.ok(chip.pins.d0.volts > 0 || chip.pins.d0.driving === "low");
});
