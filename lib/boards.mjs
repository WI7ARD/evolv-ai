// A board: the thing being made, and the record of how far it has got.
//
// Evolv could already design a circuit, program it, simulate it, state what it
// should do, check that it does, and export a netlist. What it could not do was
// hold those together as one object. Each stage answered its own question and
// forgot it: a check verdict lived until the next check, an export existed only
// as a downloaded file, and nothing anywhere knew that the netlist you sent to
// a fab was produced from a design you have since changed.
//
// This is that object. One board carries the design, what has been done to it,
// what it cost, and — the part that closes the loop — what the real board
// measured when it came back from the bench.
//
// TWO RULES, both inherited from the rest of the sandbox.
//
// Derive rather than store, wherever the answer is already in the design. Part
// count, firmware, expectations: these are read out of the snapshot every time,
// so a board cannot claim five expectations while holding none. Only things
// that *happened* are recorded, because nothing else can recover them.
//
// And a recorded stage names the design it judged. A verify verdict is about a
// particular arrangement of parts; change a resistor and the verdict is still
// true about a board that no longer exists. So every record carries a
// fingerprint of the facets it depended on, and a stage whose fingerprint no
// longer matches reads as stale rather than done. "Verified, but not since you
// changed R2" is the honest answer, and it is the one that stops somebody
// fabricating against a stale check.

import crypto from "node:crypto";
import { formatMeasure, MEASURES } from "./circuit/expectations.mjs";

export const BOARD_NAME_LIMIT = 80;
export const BOARD_INTENT_LIMIT = 600;
export const MAX_MEASUREMENTS = 200;

// The facets of a design a stage can depend on. Kept separate rather than
// hashing the whole snapshot, because they go stale for different reasons: a
// firmware edit invalidates a simulation and a check but not an export, since
// the netlist does not contain the firmware. Hashing everything together would
// report the export stale on a change that cannot possibly have affected it,
// and a staleness warning that cries wolf is one nobody reads.
export const FACETS = Object.freeze(["components", "firmware", "conditions", "expectations"]);

// The spine, in the order a board is actually taken along it. Simulate sits
// before program because a passive board is simulated before there is any
// firmware to write; a board with a microcontroller simply visits both.
//
// Intent is derived rather than recorded because it is a field on the board
// rather than something that happened to it, and because a sentence saying what
// the board is for cannot go out of date the way a measured verdict can — it is
// the one thing here that is allowed to be aspirational.
export const BOARD_STAGES = Object.freeze([
  { id: "intent", label: "Intent", kind: "derived", facets: [] },
  { id: "design", label: "Design", kind: "derived", facets: ["components"] },
  { id: "simulate", label: "Simulate", kind: "recorded", facets: ["components", "firmware", "conditions"] },
  { id: "program", label: "Program", kind: "derived", facets: ["firmware"] },
  { id: "specify", label: "Specify", kind: "derived", facets: ["expectations"] },
  { id: "verify", label: "Verify", kind: "recorded", facets: ["components", "firmware", "conditions", "expectations"] },
  { id: "export", label: "Export", kind: "recorded", facets: ["components"] },
  { id: "build", label: "Build", kind: "recorded", facets: ["components"] },
  { id: "measure", label: "Measure", kind: "measured", facets: ["components"] }
]);

export const STAGE_IDS = Object.freeze(BOARD_STAGES.map((stage) => stage.id));
const STAGES_BY_ID = new Map(BOARD_STAGES.map((stage) => [stage.id, stage]));

// Which stages are written by something happening rather than by the design
// being what it is. Only these are stored.
export const RECORDED_STAGES = Object.freeze(
  BOARD_STAGES.filter((stage) => stage.kind === "recorded").map((stage) => stage.id)
);

export function boardError(message, code = "BOARD_INVALID", status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

function now() { return new Date().toISOString(); }

// Object keys in JavaScript remember the order they were written in, and a
// fingerprint that changed when two identical parts were added in the other
// order would mark every stage stale for no reason. So keys are sorted and
// arrays that have no meaningful order are sorted too, before hashing.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function facetValue(snapshot, facet) {
  const source = snapshot || {};
  if (facet === "components") {
    return [...(source.components || [])]
      .map((component) => ({ id: component.id, kind: component.kind, values: component.values || {}, pins: component.pins || {} }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  if (facet === "expectations") {
    return [...(source.expectations || [])]
      .sort((a, b) => expectationKey(a).localeCompare(expectationKey(b)));
  }
  if (facet === "firmware") return source.firmware || {};
  if (facet === "conditions") return source.conditions || {};
  return null;
}

function expectationKey(expectation) {
  const { subject = "", measure = "", condition = "", value = 0, from = 0, until = null } = expectation || {};
  return `${subject}|${measure}|${condition}|${value}|${from}|${until}`;
}

// Short because it is an equality check between two of Evolv's own records,
// never a defence against anyone constructing a collision. Sixteen hex
// characters is far past the point where two designs on one machine collide by
// accident, and it keeps the stored record readable.
export function designFingerprint(snapshot, facets = FACETS) {
  const wanted = facets.filter((facet) => FACETS.includes(facet));
  if (!wanted.length) return "";
  const material = Object.fromEntries(wanted.sort().map((facet) => [facet, canonical(facetValue(snapshot, facet))]));
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

// A stage record, stamped with the design it was true of.
//
// One fingerprint per facet rather than one over all of them, so a stale stage
// can say which part of the design moved underneath it. "The check is out of
// date because the firmware changed" sends you somewhere; "the check is out of
// date" sends you looking.
export function stampStage(stageId, detail = {}, snapshot = {}) {
  const stage = STAGES_BY_ID.get(stageId);
  if (!stage) throw boardError(`There is no board stage called "${stageId}".`, "BOARD_UNKNOWN_STAGE");
  if (stage.kind !== "recorded") {
    throw boardError(`${stage.label} is read from the design, so it cannot be recorded.`, "BOARD_STAGE_DERIVED");
  }
  return {
    ...detail,
    at: detail.at || now(),
    fingerprints: Object.fromEntries(stage.facets.map((facet) => [facet, designFingerprint(snapshot, [facet])]))
  };
}

// Which of a record's facets no longer match the design in front of it.
export function staleFacets(stage, record, snapshot) {
  const stamped = record?.fingerprints || {};
  return stage.facets.filter((facet) => stamped[facet] !== designFingerprint(snapshot, [facet]));
}

function plural(count, word) { return `${count} ${word}${count === 1 ? "" : "s"}`; }

function listOf(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// What each derived stage reads off the design. Separated from the report below
// so the sentence a stage shows and the fact it is showing come from the same
// place — a headline that said "3 parts" beside a state of "pending" would be
// two answers to one question.
function derivedStage(stageId, board) {
  const source = board.snapshot || {};
  if (stageId === "intent") {
    const text = String(board.intent || "").trim();
    return { done: text.length > 0, headline: text.slice(0, 120) || "No stated purpose", count: text.length };
  }
  if (stageId === "design") {
    const parts = (source.components || []).length;
    return { done: parts > 0, headline: parts ? plural(parts, "part") : "No parts yet", count: parts };
  }
  if (stageId === "program") {
    const chips = Object.keys(source.firmware || {});
    return {
      done: chips.length > 0,
      headline: chips.length ? `Firmware on ${chips.join(", ")}` : "No firmware",
      count: chips.length
    };
  }
  if (stageId === "specify") {
    const stated = (source.expectations || []).length;
    return { done: stated > 0, headline: stated ? plural(stated, "expectation") : "Nothing expected yet", count: stated };
  }
  return { done: false, headline: "", count: 0 };
}

function recordedHeadline(stageId, record) {
  if (stageId === "simulate") {
    const seconds = Number(record.seconds) || 0;
    const supply = record.supplyAmps === null || record.supplyAmps === undefined
      ? "" : `, ${formatMeasure("current", record.supplyAmps)} from the supply`;
    return `Ran ${seconds < 1 ? `${(seconds * 1000).toFixed(0)}ms` : `${seconds.toFixed(2)}s`}${supply}`;
  }
  if (stageId === "verify") {
    const passed = Number(record.passed) || 0;
    const failed = Number(record.failed) || 0;
    if (failed) return `${failed} of ${passed + failed} not met`;
    return passed === 1 ? "Its one expectation met" : `All ${passed} expectations met`;
  }
  if (stageId === "export") {
    const problems = (record.problems || []).length;
    return problems ? `${record.filename || "Exported"} — ${plural(problems, "problem")}` : String(record.filename || "Exported");
  }
  if (stageId === "build") return String(record.note || "").slice(0, 120) || "Built";
  return "";
}

// The timeline. One entry per stage, always all of them and always in order,
// because a spine that hid its unreached stages would not read as a spine — the
// empty ones are what tell you where you are.
export function stageReport(board = {}) {
  const snapshot = board.snapshot || {};
  const stages = board.stages || {};
  const measurements = board.measurements || [];
  return BOARD_STAGES.map((stage) => {
    if (stage.kind === "derived") {
      const derived = derivedStage(stage.id, board);
      return { id: stage.id, label: stage.label, state: derived.done ? "done" : "pending", headline: derived.headline, at: null };
    }
    if (stage.kind === "measured") {
      const latest = measurements.reduce((newest, entry) =>
        (!newest || String(entry.measuredAt) > String(newest.measuredAt) ? entry : newest), null);
      return {
        id: stage.id, label: stage.label,
        state: measurements.length ? "done" : "pending",
        headline: measurements.length ? plural(measurements.length, "reading") : "Nothing measured yet",
        at: latest?.measuredAt || null
      };
    }
    const record = stages[stage.id];
    if (!record) {
      return { id: stage.id, label: stage.label, state: "pending", headline: "", at: null };
    }
    // Which facet moved is the actionable half of "stale": it is the difference
    // between re-running a check and re-exporting a netlist.
    const changed = staleFacets(stage, record, snapshot);
    // A check that found four unmet expectations has run, but calling that
    // "done" and drawing it the same as a clean one is how a timeline ends up
    // reassuring. Stale wins over failed: a verdict about a design that has
    // moved on is not worth arguing with either way.
    const failed = stage.id === "verify" && Number(record.failed) > 0;
    return {
      id: stage.id, label: stage.label,
      state: changed.length ? "stale" : failed ? "failed" : "done",
      headline: recordedHeadline(stage.id, record),
      at: record.at || null,
      changed
    };
  });
}

// One sentence for the whole board — the furthest stage it has actually
// reached, and the first thing standing in the way of the next one.
const REACHED = new Set(["done", "failed"]);

export function boardSummary(board = {}) {
  const report = stageReport(board);
  const stale = report.find((stage) => stage.state === "stale");
  const reached = report.filter((stage) => REACHED.has(stage.state)).at(-1);
  if (stale) {
    const because = stale.changed?.length ? ` — the ${listOf(stale.changed)} changed since` : " — the design has changed since";
    return `${reached ? `${reached.label}: ${reached.headline}. ` : ""}${stale.label} is out of date${because}.`;
  }
  if (!reached) return "Nothing has been designed yet.";
  // The next thing to do is the first unreached stage *after* the furthest one
  // reached, not the first unreached stage overall. A board that was exported
  // without anyone writing down why it exists has skipped intent, and being
  // told to go back and do that as its "next step" would be pedantry standing
  // in front of the actual next step.
  const furthest = report.indexOf(reached);
  // A failed check is its own next step: there is no point exporting a board
  // that does not do what was asked of it.
  if (reached.state === "failed") return `${reached.label}: ${reached.headline}.`;
  const next = report.slice(furthest + 1).find((stage) => stage.state === "pending");
  return next ? `${reached.label}: ${reached.headline}. Next: ${next.label.toLowerCase()}.` : `${reached.label}: ${reached.headline}.`;
}

// How far apart a simulation and a bench meter are allowed to be before the
// difference is worth pointing at. These are bands for reading, not a verdict:
// every comparison carries both numbers and the gap between them, because a
// grade would invite somebody to read "agrees" and stop looking, and the whole
// value of this stage is in looking.
export const AGREEMENT_CLOSE = 0.10;
export const AGREEMENT_NEAR = 0.25;

export function normaliseMeasurement(input = {}) {
  const subject = String(input.subject || "").trim().slice(0, 32);
  const measure = String(input.measure || "").trim();
  if (!subject) throw boardError("A measurement needs to name what was measured.", "BOARD_MEASURE_SUBJECT");
  if (!MEASURES.includes(measure)) {
    throw boardError(`measure must be one of: ${MEASURES.join(", ")}.`, "BOARD_MEASURE_UNKNOWN");
  }
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw boardError("A measurement needs a number.", "BOARD_MEASURE_VALUE");
  return {
    subject, measure, value,
    note: String(input.note || "").trim().slice(0, 200),
    measuredAt: input.measuredAt || now()
  };
}

// The comparison this whole object exists for: what the solver said, beside
// what the board did.
//
// The simulated figure comes from the last check, because that is the only
// record that pairs a subject and a measure with a number the solver produced.
// A measurement of something never checked reports that plainly rather than
// guessing — an unstated comparison is not a small comparison, it is no
// comparison.
export function compareMeasurement(measurement, verify = null) {
  const results = verify?.results || [];
  // "toggles at" is checked in hertz, so its measured figure is a rate rather
  // than a level. Comparing a brightness against one printed "simulated 500%"
  // for a 5Hz blink — the same unit confusion, seen from the other side.
  const comparable = results.filter((result) =>
    result.subject === measurement.subject && result.measure === measurement.measure
    && result.condition !== "toggles at");
  const rateOnly = !comparable.length && results.some((result) =>
    result.subject === measurement.subject && result.measure === measurement.measure);
  const match = comparable[0];
  const simulated = match && Number.isFinite(Number(match.measured)) ? Number(match.measured) : null;
  const measured = Number(measurement.value);
  const shown = formatMeasure(measurement.measure, measured);
  if (simulated === null) {
    return {
      ...measurement, simulated: null, difference: null, ratio: null, agreement: "unchecked",
      detail: rateOnly
        ? `Measured ${shown}. The only check of ${measurement.subject} ${measurement.measure} is a rate in hertz, which is not the same kind of number.`
        : `Measured ${shown}. Nothing in the last check covers ${measurement.subject} ${measurement.measure}, so there is nothing to compare it against.`
    };
  }
  const difference = measured - simulated;
  const predicted = formatMeasure(measurement.measure, simulated);
  // A simulation of zero cannot be a percentage out, and reporting it as
  // "unchecked" was worse than saying nothing: it hid the single most useful
  // disagreement the bench can produce — the solver said this would not happen,
  // and it happened.
  const scale = Math.abs(simulated);
  if (scale === 0) {
    const same = measured === 0;
    return {
      ...measurement, simulated, difference, ratio: null,
      agreement: same ? "agrees" : "differs",
      detail: same
        ? `Simulated ${predicted}, measured ${shown}.`
        : `Simulated ${predicted}, measured ${shown} — the simulation predicted nothing here at all.`
    };
  }
  // Against the simulated figure, not the measured one, because the simulation
  // is the prediction being tested. Dividing by the measurement would make the
  // error depend on which of the two happened to be larger.
  const ratio = Math.abs(difference) / scale;
  const agreement = ratio <= AGREEMENT_CLOSE ? "agrees" : ratio <= AGREEMENT_NEAR ? "near" : "differs";
  return {
    ...measurement, simulated, difference, ratio, agreement,
    detail: `Simulated ${predicted}, measured ${shown} — ${(ratio * 100).toFixed(0)}% ${difference > 0 ? "above" : "below"}.`
  };
}

export function compareMeasurements(measurements = [], verify = null) {
  return measurements.map((measurement) => compareMeasurement(measurement, verify));
}

// The board as it is read: the design, the timeline, the money, and the bench.
export function describeBoard(board = {}) {
  const report = stageReport(board);
  const comparisons = compareMeasurements(board.measurements || [], board.stages?.verify || null);
  // The last check, carried out whole.
  //
  // Without it the page showed "2 expectations, not yet checked" beside a
  // timeline saying "All 2 expectations met" — two panels on one screen
  // disagreeing, because one of them only knew about checks run since the tab
  // opened. A recorded verdict is the better source, and it comes with the
  // caveat the timeline already computes: whether the design has moved since.
  const record = board.stages?.verify || null;
  const verifyStage = report.find((stage) => stage.id === "verify");
  return {
    id: board.id,
    name: board.name,
    intent: board.intent || "",
    projectId: board.projectId || null,
    stages: report,
    lastCheck: record ? {
      at: record.at, passed: record.passed, failed: record.failed,
      summary: record.summary, results: record.results || [],
      stale: verifyStage?.state === "stale"
    } : null,
    summary: boardSummary(board),
    measurements: comparisons,
    spendMicros: Number(board.spendMicros) || 0,
    createdAt: board.createdAt || null,
    updatedAt: board.updatedAt || null
  };
}
