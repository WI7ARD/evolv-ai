import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normaliseExpectation, checkExpectation, describeExpectation, summarise, formatMeasure,
  secondsNeededFor, MEASURES, CONDITIONS
} from "../lib/circuit/expectations.mjs";
import { handleCircuitRoutes } from "../server/circuit-routes.mjs";
import { CircuitService } from "../lib/circuit.mjs";
import { BenchService } from "../lib/bench.mjs";

// The point of this stage is that a failure is a diagnosis. So most of these
// tests assert what the failure *says*, not just that it failed.

const square = (hertz, seconds, low = 0, high = 5, step = 1e-4) => {
  const points = [];
  for (let at = step; at <= seconds + 1e-12; at += step) {
    points.push([Number(at.toFixed(9)), (at * hertz) % 1 < 0.5 ? high : low]);
  }
  return points;
};
const ramp = (to, seconds, step = 1e-3) => {
  const points = [];
  for (let at = step; at <= seconds + 1e-12; at += step) points.push([Number(at.toFixed(9)), (at / seconds) * to]);
  return points;
};
const state = (input) => normaliseExpectation(input);

test("a failure carries the number, because that is the whole diagnosis", () => {
  // An LED behind a resistor ten times too big. "Not lit" sends you looking at
  // the firmware; "the most it managed was 5%" sends you to the resistor, which
  // is where the fault is.
  const dim = checkExpectation(
    state({ subject: "D1", measure: "lit", condition: "reaches", value: 0.5 }),
    [[0.001, 0.05], [0.002, 0.05], [0.003, 0.048]]
  );
  assert.equal(dim.pass, false);
  assert.match(dim.detail, /5%/, `the measured figure has to be in it: ${dim.detail}`);
  assert.equal(dim.measured, 0.05);

  // And a passing one carries it too. A green tick with no reading is a claim
  // to be taken on trust.
  const fine = checkExpectation(
    state({ subject: "D1", measure: "current", condition: "never above", value: 0.02 }),
    [[0.001, 0.0079], [0.002, 0.0081]]
  );
  assert.equal(fine.pass, true);
  assert.match(fine.detail, /8\.10mA/, fine.detail);
});

test("every condition is judged the way a bench would judge it", () => {
  const at = (condition, extra, points) => checkExpectation(state({ subject: "X", measure: "voltage", condition, ...extra }), points);

  // A rating check. The instant matters as much as the figure — a spike at 3ms
  // is an inrush, the same figure at 3s is a fault.
  const over = at("never above", { value: 5 }, [[0.001, 4.9], [0.002, 6.2], [0.003, 4.8]]);
  assert.equal(over.pass, false);
  assert.equal(over.at, 0.002);
  assert.match(over.detail, /6\.200V.*2\.0ms/);

  const under = at("never below", { value: 4.5 }, [[0.001, 4.9], [0.002, 3.1]]);
  assert.equal(under.pass, false);
  assert.match(under.detail, /3\.100V/);

  // "reaches" reports when it got there, or the best it managed if it never did.
  const got = at("reaches", { value: 3 }, ramp(5, 0.1));
  assert.equal(got.pass, true);
  assert.ok(got.at > 0.05 && got.at < 0.065, `should cross three fifths of the way up, at ${got.at}`);
  const missed = at("reaches", { value: 9 }, ramp(5, 0.1));
  assert.equal(missed.pass, false);
  assert.match(missed.detail, /Never got there.*5\.000V/);

  const band = at("stays between", { value: 4.5, upper: 5.5 }, [[0.001, 4.9], [0.002, 5.9]]);
  assert.equal(band.pass, false);
  assert.match(band.detail, /above the band, to 5\.900V/);

  // A 50% square wave averages half its swing, which is the figure a meter shows.
  const mean = at("averages", { value: 2.5, tolerance: 0.1 }, square(10, 1));
  assert.equal(mean.pass, true, mean.detail);
  assert.ok(Math.abs(mean.measured - 2.5) < 0.05, `measured ${mean.measured}`);
});

test("frequency is measured, not assumed, and a still signal says so", () => {
  const blinking = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 10, tolerance: 0.5 }),
    square(10, 1)
  );
  assert.equal(blinking.pass, true, blinking.detail);
  assert.ok(Math.abs(blinking.measured - 10) < 0.5, `measured ${blinking.measured}Hz`);

  // Twice the rate asked for: the ratio is in the message because "5Hz, not
  // 10Hz" leaves the reader to do the division that says "your delay is half
  // what you meant".
  const fast = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 10, tolerance: 0.5 }),
    square(20, 1)
  );
  assert.equal(fast.pass, false);
  assert.match(fast.detail, /2\.00×/, fast.detail);

  // A pin stuck high is the failure this exists to catch, and it must not be
  // reported as a frequency of zero as though that were a measurement.
  const stuck = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 10, tolerance: 0.5 }),
    [[0.1, 5], [0.2, 5], [0.3, 5], [0.4, 5]]
  );
  assert.equal(stuck.pass, false);
  assert.match(stuck.detail, /Never switched/);
});

test("a noisy edge is one edge, not three", () => {
  // Counting bare threshold crossings makes a frequency counter lie, and it
  // lies upwards — which is the direction that looks like the circuit working.
  const points = [];
  let at = 0;
  for (let cycle = 0; cycle < 10; cycle += 1) {
    for (const value of [0, 0.1, 2.4, 2.6, 2.4, 2.6, 5, 5, 5, 4.9, 2.6, 2.4, 2.6, 0.1, 0]) {
      at += 1e-3;
      points.push([Number(at.toFixed(6)), value]);
    }
  }
  const measured = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 66.7, tolerance: 5 }), points
  );
  assert.ok(Math.abs(measured.measured - 66.7) < 5,
    `fifteen samples per cycle at 1ms is 66.7Hz, measured ${measured.measured}Hz`);
});

test("a window means the expectation is about that window", () => {
  // An inrush that is fine at switch-on and a fault a second later is the
  // reason windows exist at all.
  const points = [[0.001, 3], [0.05, 0.5], [0.5, 0.5], [0.9, 0.5]];
  const whole = checkExpectation(state({ subject: "M1", measure: "current", condition: "never above", value: 1 }), points);
  assert.equal(whole.pass, false, "across the whole run the inrush counts");
  const settled = checkExpectation(
    state({ subject: "M1", measure: "current", condition: "never above", value: 1, from: 0.02 }), points);
  assert.equal(settled.pass, true, "after the inrush it should be fine");
  assert.match(settled.statement, /between 20\.0ms and the end/);

  // And a window with nothing in it is reported as that, rather than passing
  // silently — an expectation that cannot fail is worse than no expectation.
  const empty = checkExpectation(
    state({ subject: "M1", measure: "current", condition: "never above", value: 1, from: 2, until: 3 }), points);
  assert.equal(empty.pass, false);
  assert.match(empty.detail, /Nothing was recorded/);
});

test("a badly written expectation is refused where it is written", () => {
  // Not later, as a check that quietly never fails.
  assert.throws(() => state({ subject: "", measure: "voltage", condition: "reaches", value: 1 }), /Say what/);
  assert.throws(() => state({ subject: "D1", measure: "lumens", condition: "reaches", value: 1 }), /Measure must be/);
  assert.throws(() => state({ subject: "D1", measure: "lit", condition: "glows", value: 1 }), /Condition must be/);
  assert.throws(() => state({ subject: "D1", measure: "lit", condition: "reaches" }), /needs a number/);
  assert.throws(() => state({ subject: "D1", measure: "lit", condition: "reaches", value: 40 }), /0 to 1/);
  assert.throws(() => state({ subject: "X", measure: "voltage", condition: "stays between", value: 5, upper: 1 }), /above the bottom/);
  assert.throws(() => state({ subject: "X", measure: "voltage", condition: "never above", value: 1, from: 1, until: 0.5 }), /after its start/);

  // A tolerance of zero can only fail, which reads as a broken circuit rather
  // than a badly written test, so it is filled in rather than taken literally.
  assert.ok(state({ subject: "X", measure: "voltage", condition: "averages", value: 2.5, tolerance: 0 }).tolerance > 0);
});

test("an expectation reads back as the sentence it is", () => {
  assert.equal(describeExpectation(state({ subject: "D1", measure: "lit", condition: "reaches", value: 0.5, until: 1 })),
    "D1 lit reaches 50% within 1.000s");
  assert.equal(describeExpectation(state({ subject: "PIN9", measure: "current", condition: "never above", value: 0.02 })),
    "PIN9 current never goes above 20.00mA");
  assert.equal(describeExpectation(state({ subject: "M1", measure: "rpm", condition: "reaches", value: 2000, until: 0.2 })),
    "M1 rpm reaches 2000rpm within 200.0ms");
  // Every measure and condition has to produce a sentence; a combination that
  // fell through to a default would read as a description of nothing.
  for (const measure of MEASURES) {
    for (const condition of CONDITIONS) {
      const sentence = describeExpectation(state({
        subject: "X", measure, condition, value: measure === "lit" ? 0.5 : 1, upper: measure === "lit" ? 0.9 : 2, tolerance: 0.1
      }));
      assert.ok(sentence.length > 8 && !sentence.includes("undefined"), `${measure}/${condition}: ${sentence}`);
    }
  }
});

test("figures are written the way a datasheet writes them", () => {
  assert.equal(formatMeasure("current", 0.00794), "7.94mA");
  assert.equal(formatMeasure("current", 2.5e-6), "2.5µA");
  assert.equal(formatMeasure("current", 1.5), "1.500A");
  assert.equal(formatMeasure("lit", 0.663), "66%");
  assert.equal(formatMeasure("voltage", 4.9999), "5.000V");
});

test("the summary leads with what failed", () => {
  // A report whose first line is "6 of 7 passed" buries the only line anyone
  // needed to read.
  const results = [
    { pass: true, statement: "a", detail: "fine" },
    { pass: false, statement: "D1 lit reaches 50%", detail: "Never got there. The most it managed was 5%." }
  ];
  const line = summarise(results);
  assert.match(line, /^1 of 2 not met/);
  assert.match(line, /The most it managed was 5%/);
  assert.equal(summarise([{ pass: true }, { pass: true }]), "All 2 expectations met.");
});

// End to end: a real board, checked the way someone would check one.

const blinker = (ohms = 330, ms = 100) => {
  const service = new CircuitService();
  service.apply("add", { kind: "supply", volts: 5, pins: { positive: "VCC", negative: "GND" } });
  service.apply("add", { kind: "mcu", pins: { d0: "IO", vcc: "VCC", gnd: "GND" } });
  service.apply("add", { kind: "resistor", ohms, pins: { a: "IO", b: "N1" } });
  service.apply("add", { kind: "led", colour: "red", pins: { anode: "N1", cathode: "GND" } });
  service.apply("add", { kind: "ground", pins: { pin: "GND" } });
  service.apply("firmware", { id: "U1", source:
    `function setup() { pinMode(0, 1); }
     function loop() { digitalWrite(0, 1); delay(${ms}); digitalWrite(0, 0); delay(${ms}); }` });
  return service;
};

test("a blinking board is checked against what it was supposed to do", () => {
  const service = blinker();
  service.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  service.apply("expect", { subject: "D1", measure: "current", condition: "never above", value: 0.02 });
  service.apply("expect", { subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 });
  service.apply("expect", { subject: "VCC", measure: "voltage", condition: "never below", value: 4.9 });

  const report = service.apply("check", { seconds: 0.6, dt: 2e-4 });
  assert.equal(report.ran, true, JSON.stringify(report.findings));
  assert.equal(report.failed, 0, report.results.filter((r) => !r.pass).map((r) => `${r.statement}: ${r.detail}`).join(" | "));
  assert.equal(report.passed, 4);
  assert.match(report.summary, /All 4 expectations met/);
  // And the traces the verdict was read off are left where the page can show them.
  assert.ok(report.traces.length >= 3, "the recording behind the verdict is kept");
});

test("the same board built wrong fails, and says which part is wrong", () => {
  // Thirty times the resistance: the circuit still works, the LED still lights,
  // and the design is still no good. This is precisely the failure a run cannot
  // report and an expectation can.
  const service = blinker(10_000);
  service.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  const report = service.apply("check", { seconds: 0.4, dt: 2e-4 });
  assert.equal(report.failed, 1);
  assert.match(report.results[0].detail, /Never got there/);
  assert.ok(report.results[0].measured < 0.2, `and says how far off: ${report.results[0].measured}`);
});

test("firmware with the wrong delay is caught by the frequency, not by reading it", () => {
  const service = blinker(330, 25);
  service.apply("expect", { subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 });
  const report = service.apply("check", { seconds: 0.6, dt: 2e-4 });
  assert.equal(report.failed, 1);
  // 25ms each way is 20Hz, four times what was asked for.
  assert.ok(Math.abs(report.results[0].measured - 20) < 1, `measured ${report.results[0].measured}Hz`);
  assert.match(report.results[0].detail, /4\.0\d×/, report.results[0].detail);
});

test("a check runs from cold, so the verdict does not depend on what came before", () => {
  // A check that continued from wherever the last run stopped would give
  // different answers depending on what someone had been doing beforehand, and
  // a test that depends on the order you ran it in is not a test.
  const service = blinker();
  service.apply("expect", { subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 });
  const cold = service.apply("check", { seconds: 0.6, dt: 2e-4 });
  service.apply("run", { seconds: 0.13, dt: 2e-4 });
  service.apply("run", { seconds: 0.07, dt: 2e-4 });
  const afterwards = service.apply("check", { seconds: 0.6, dt: 2e-4 });
  assert.equal(afterwards.passed, cold.passed);
  assert.ok(Math.abs(afterwards.results[0].measured - cold.results[0].measured) < 1e-6,
    `${afterwards.results[0].measured} vs ${cold.results[0].measured}`);
});

test("an expectation about something that is not there is refused", () => {
  const service = blinker();
  assert.throws(() => service.apply("expect", { subject: "NOWHERE", measure: "voltage", condition: "reaches", value: 1 }),
    (error) => error.code === "CIRCUIT_UNKNOWN_SUBJECT");
  // A part measured as a net, and a net measured as a part. Left to the check,
  // both produce an empty trace and read as a circuit that did nothing, which
  // sends the reader looking in entirely the wrong place.
  assert.throws(() => service.apply("expect", { subject: "R1", measure: "voltage", condition: "reaches", value: 1 }),
    /Measure the voltage on a net/);
  assert.throws(() => service.apply("expect", { subject: "IO", measure: "current", condition: "reaches", value: 1 }),
    /a net has no current/);
  assert.throws(() => service.apply("expect", { subject: "R1", measure: "lit", condition: "reaches", value: 0.5 }),
    /not an LED/);
  assert.throws(() => service.apply("check", {}), (error) => error.code === "CIRCUIT_NO_EXPECTATIONS");
});

test("expectations are part of the design and reopen with it", () => {
  const service = blinker();
  service.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  service.apply("expect", { subject: "D1", measure: "current", condition: "never above", value: 0.02 });
  const snapshot = service.snapshot();
  assert.equal(snapshot.expectations.length, 2);

  const reopened = new CircuitService();
  reopened.restore(snapshot);
  assert.equal(reopened.readExpectations().length, 2);
  assert.equal(reopened.apply("check", { seconds: 0.3, dt: 2e-4 }).failed, 0);

  // Stating the same thing twice is not two requirements.
  const again = new CircuitService();
  again.restore(snapshot);
  again.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  assert.equal(again.readExpectations().length, 2);

  // And one about a part that did not survive is dropped rather than stranding
  // the whole design.
  const partial = new CircuitService();
  partial.restore({ ...snapshot, components: snapshot.components.filter((part) => part.id !== "D1") });
  assert.equal(partial.readExpectations().length, 0);
});

test("the verdict reaches the page, and the page still computes nothing", async () => {
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const markup = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(markup, /id="circuit-checks"/);
  assert.match(markup, /id="circuit-check"/, "and something to press");
  assert.match(script, /\/api\/circuit\/check/, "which goes through the ordinary route");

  const panel = script.slice(script.indexOf("function renderChecks"), script.indexOf("function renderMcus"));
  assert.ok(panel.includes("result.detail") && panel.includes("result.statement"),
    "the measured figure and the statement both belong on the line");
  // The page renders the verdict; it must never reach one. Two answers to
  // "did this pass" would drift, and the one on screen is the one believed.
  assert.doesNotMatch(panel, /checkExpectation|Math\.abs|measured [<>]/, "the page must not judge anything");
});

test("a run too short to see a cycle says so, rather than blaming the circuit", () => {
  // The first version of this ran a 5Hz blink for 52ms and reported "never
  // switched", which is a false statement about the circuit made from a true
  // one about the run. Not seeing a cycle and there not being one are different
  // findings and only one of them is about the board.
  const short = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 }),
    square(5, 0.05)
  );
  assert.equal(short.pass, false, "it still cannot pass — nothing was demonstrated");
  assert.match(short.detail, /less than two cycles/, short.detail);
  assert.doesNotMatch(short.detail, /Never switched/);

  // Long enough, and genuinely still: that is the circuit's fault and says so.
  const stuck = checkExpectation(
    state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 }),
    Array.from({ length: 200 }, (unused, index) => [(index + 1) * 0.01, 5])
  );
  assert.match(stuck.detail, /Never switched/, stuck.detail);
});

test("a check runs long enough to answer what was asked of it", () => {
  // A frequency implies its own timescale: five cycles at 5Hz is a second, and
  // no shorter run can judge it.
  assert.ok(secondsNeededFor(state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 5 })) >= 1);
  assert.ok(secondsNeededFor(state({ subject: "IO", measure: "voltage", condition: "toggles at", value: 100 })) < 0.1);
  // A window says it outright, and beats the default.
  assert.equal(secondsNeededFor(state({ subject: "X", measure: "voltage", condition: "reaches", value: 1, until: 3 })), 3);

  const service = blinker(330, 100);
  service.apply("expect", { subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 });
  const report = service.apply("check", {});
  assert.ok(report.seconds >= 1, `a 5Hz check needs at least a second, ran ${report.seconds}s`);
  assert.equal(report.failed, 0, report.results[0].detail);
});

test("the expectation routes are reachable the way the server calls them", async () => {
  // Both of these were written as readBody(bodyLimit) and threw on the first
  // real request. Every service-level test passed; the app did not work. So
  // they are exercised here through the router itself, with a readBody that
  // checks it was called properly.
  const circuitService = blinker();
  // A bench with no board open, which is the ordinary case for a scratch
  // circuit: it runs and checks, and there is nothing to write it down against.
  const bench = new BenchService({ database: null, circuitService });
  const sent = [];
  const call = (method, pathname, body) => handleCircuitRoutes({
    req: { method },
    res: {},
    url: new URL(`http://local${pathname}`),
    readBody: async (request, limit) => {
      assert.equal(request?.method, method, "readBody takes the request first");
      assert.equal(typeof limit, "number", "and the body limit second");
      return body;
    },
    bodyLimit: 1_000_000,
    json: (res, status, payload) => sent.push({ status, payload }),
    circuitService,
    bench
  });

  await call("POST", "/api/circuit/expectations", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  assert.equal(sent.at(-1).status, 200);
  assert.equal(sent.at(-1).payload.id, "E1");

  await call("POST", "/api/circuit/check", { seconds: 0.4, dt: 2e-4 });
  assert.equal(sent.at(-1).payload.failed, 0, JSON.stringify(sent.at(-1).payload.results));
  assert.match(sent.at(-1).payload.results[0].detail, /Got to/);

  await call("DELETE", "/api/circuit/expectations?id=E1");
  assert.equal(sent.at(-1).payload.expectations.length, 0);
});

test("the run behind a verdict is recorded once per question", () => {
  // The expectations and the user's own probes are merged for the run. Keyed
  // differently, they did not merge: a probe on D1 and an expectation about
  // D1's current were two recordings of one thing, and the page drew the trace
  // twice.
  const service = blinker();
  service.apply("probe", { target: "D1" });
  service.apply("probe", { target: "IO" });
  service.apply("expect", { subject: "D1", measure: "current", condition: "never above", value: 0.02 });
  service.apply("expect", { subject: "D1", measure: "lit", condition: "reaches", value: 0.5 });
  service.apply("expect", { subject: "IO", measure: "voltage", condition: "toggles at", value: 5, tolerance: 0.3 });

  const report = service.apply("check", { seconds: 0.6, dt: 2e-4 });
  const keys = report.traces.map((trace) => `${trace.target}:${trace.kind}`);
  assert.deepEqual([...new Set(keys)].sort(), keys.sort(), `a trace each, got ${keys.join(", ")}`);
  assert.equal(keys.length, 3, `D1 current, D1 brightness, IO voltage — got ${keys.join(", ")}`);
});

test("brightness is drawn as brightness, not as amps", async () => {
  // A 66% lit LED was labelled "660mA" — thirty times the rating of a part
  // shown drawing 7.94mA two plots below it. Every probe kind needs its own
  // unit, and the only way that stays true is to check the table covers them.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const units = script.slice(script.indexOf("const TRACE_UNITS"), script.indexOf("function seconds"));
  for (const kind of ["net", "part", "speed", "angle", "lit"]) {
    assert.match(units, new RegExp(`\\b${kind}:`), `${kind} needs a unit and a label of its own`);
  }
  assert.match(units, /lit: "brightness"|lit: "brightness"/, "and brightness is not called current");
});

test("a plot whose axis reads the same at both ends says how big the swing is", async () => {
  // Every trace is drawn full height. A supply rippling by 0.4mV under a
  // switching load — which is real, and exactly the load current times the
  // supply's internal resistance — is therefore drawn identically to a pin
  // swinging five volts, with "5V" at both ends of the axis. That reads as a
  // rail collapsing. The shape is honest; the axis has to be too.
  const script = await readFile(new URL("../public/circuit.js", import.meta.url), "utf8");
  const plot = script.slice(script.indexOf("circuit-trace-scale"), script.indexOf("What an output is doing"));
  assert.match(plot, /unit\(high\) === unit\(low\)/, "the collision is what has to be noticed");
  assert.match(plot, /swing/, "and the swing is what resolves it");

  // And the ripple it is about is a real figure, not a rendering artefact.
  const service = blinker(330, 50);
  service.apply("probe", { target: "VCC" });
  const values = service.apply("run", { seconds: 0.3, dt: 2e-4 }).traces[0].points.map(([, value]) => value);
  const swing = Math.max(...values) - Math.min(...values);
  // 7.94mA through the supply's own 0.05Ω.
  assert.ok(Math.abs(swing - (0.00794 * 0.05)) < 5e-5, `expected about 400µV of ripple, measured ${swing * 1000}mV`);
});
