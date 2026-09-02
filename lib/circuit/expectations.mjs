// Saying what the finished thing should do, and being told whether it does.
//
// Everything else in this sandbox answers "what happens". An expectation asks
// the other question — "is that what I wanted" — and it is a different question
// because it can fail. A run that produces 0.4mA through an LED is a successful
// run; it is a failed circuit, and nothing before this stage would say so.
//
// Two rules the whole design follows.
//
// A failure always carries the measured figure. "LED1 was never lit" is not a
// diagnosis; "LED1 reached 8% brightness, needed 50%" tells you the resistor is
// too big and roughly by how much. Every result here carries the number it
// judged, pass or fail, so a passing expectation is evidence rather than a
// green tick.
//
// And expectations are about the device, not about the code. An assertion
// written inside firmware can only ever see the pin it just set — it cannot see
// the current that pin caused, or whether the LED on the end of it lit, or
// whether the motor got up to speed. Those are the things that go wrong on a
// bench, so those are the things this can express.

export const MEASURES = Object.freeze(["voltage", "current", "lit", "rpm", "angle"]);

export const CONDITIONS = Object.freeze([
  "never above",   // a rating check: nothing in the window may exceed value
  "never below",   // the mirror, for a rail that must hold up
  "reaches",       // gets to value at some point, optionally by a deadline
  "stays between", // lives inside a band the whole time
  "averages",      // mean is value, within tolerance — duty cycles, current budgets
  "toggles at"     // switches at value Hz, within tolerance — blink and PWM
]);

// Which probe records a measure, since an expectation is checked against a
// trace and a trace comes from a probe.
const PROBE_FOR = Object.freeze({ voltage: "net", current: "part", lit: "lit", rpm: "speed", angle: "angle" });

export function expectationError(message, code = "CIRCUIT_EXPECT_INVALID") {
  return Object.assign(new Error(message), { code, status: 400, expose: true });
}

export function probeKindFor(measure) {
  return PROBE_FOR[measure] || null;
}

// How a figure is written when it is reported back.
//
// Brightness is a percentage because that is how it is asked for; current is in
// milliamps below an amp because that is how every datasheet writes it. The
// alternative — everything in SI to six places — makes a report that is
// technically complete and unreadable, and unreadable is the same as unread.
export function formatMeasure(measure, value) {
  const number = Number(value) || 0;
  if (measure === "lit") return `${Math.round(number * 100)}%`;
  if (measure === "current") {
    if (Math.abs(number) < 1e-3) return `${(number * 1e6).toFixed(1)}µA`;
    if (Math.abs(number) < 1) return `${(number * 1e3).toFixed(2)}mA`;
    return `${number.toFixed(3)}A`;
  }
  if (measure === "voltage") return `${number.toFixed(3)}V`;
  if (measure === "rpm") return `${Math.round(number)}rpm`;
  if (measure === "angle") return `${number.toFixed(1)}°`;
  return String(Number(number.toPrecision(4)));
}

export function formatSeconds(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 1e-3) return `${(number * 1e6).toFixed(1)}µs`;
  if (Math.abs(number) < 1) return `${(number * 1e3).toFixed(1)}ms`;
  return `${number.toFixed(3)}s`;
}

// Read one back as a sentence, which is how it is shown and how it reads in a
// report. Built from the stored fields rather than stored as text, so an
// expectation cannot say one thing and check another.
export function describeExpectation(expectation) {
  const { subject, measure, condition, value, upper, tolerance, from, until } = expectation;
  const window = from > 0 || until !== null
    ? ` between ${formatSeconds(from)} and ${until === null ? "the end" : formatSeconds(until)}`
    : "";
  const figure = (amount) => formatMeasure(measure, amount);
  switch (condition) {
    case "never above": return `${subject} ${measure} never goes above ${figure(value)}${window}`;
    case "never below": return `${subject} ${measure} never drops below ${figure(value)}${window}`;
    case "reaches": return `${subject} ${measure} reaches ${figure(value)}${until === null ? "" : ` within ${formatSeconds(until)}`}`;
    case "stays between": return `${subject} ${measure} stays between ${figure(value)} and ${figure(upper)}${window}`;
    case "averages": return `${subject} ${measure} averages ${figure(value)} ± ${figure(tolerance)}${window}`;
    case "toggles at": return `${subject} toggles at ${value}Hz ± ${tolerance}Hz${window}`;
    default: return `${subject} ${condition} ${figure(value)}`;
  }
}

// Validate and normalise one, so a malformed expectation is refused where it is
// written rather than surfacing later as a check that quietly never fails.
export function normaliseExpectation(input, { subjects = [] } = {}) {
  const subject = String(input?.subject || "").trim();
  if (!subject) throw expectationError("Say what the expectation is about: a part such as D1, or a net such as OUT.");
  if (subjects.length && !subjects.includes(subject)) {
    throw expectationError(`There is no net or part called ${subject} in this circuit.`, "CIRCUIT_UNKNOWN_SUBJECT");
  }
  const measure = String(input?.measure || "").trim();
  if (!MEASURES.includes(measure)) {
    throw expectationError(`Measure must be one of: ${MEASURES.join(", ")}.`);
  }
  const condition = String(input?.condition || "").trim();
  if (!CONDITIONS.includes(condition)) {
    throw expectationError(`Condition must be one of: ${CONDITIONS.join(", ")}.`);
  }
  const value = Number(input?.value);
  if (!Number.isFinite(value)) throw expectationError("An expectation needs a number to check against.");

  const from = Math.max(0, Number(input?.from) || 0);
  const until = input?.until === undefined || input?.until === null || input?.until === ""
    ? null : Number(input.until);
  if (until !== null && (!Number.isFinite(until) || until <= from)) {
    throw expectationError("The end of the window has to be a time after its start.");
  }

  let upper = null;
  if (condition === "stays between") {
    upper = Number(input?.upper);
    if (!Number.isFinite(upper)) throw expectationError('"stays between" needs both ends of the band.');
    if (upper <= value) throw expectationError("The top of the band has to be above the bottom of it.");
  }

  // A tolerance of zero is never what anyone means. A simulated average lands
  // within a fraction of a percent of the arithmetic and never exactly on it,
  // so a zero-tolerance expectation is one that can only fail — which looks
  // like a broken circuit rather than a badly written test.
  let tolerance = null;
  if (condition === "averages" || condition === "toggles at") {
    tolerance = Number(input?.tolerance);
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      tolerance = condition === "toggles at" ? Math.max(0.5, value * 0.05) : Math.max(1e-9, Math.abs(value) * 0.05);
    }
  }

  // Brightness runs 0 to 1, and a figure outside that is a unit mistake worth
  // catching. Except under "toggles at", whose value is a frequency in Hz and
  // not in the measure's units at all — which made "D1 lit toggles at 5Hz", the
  // single most natural thing anyone says about a blinking LED, impossible to
  // state. The band's upper end is checked too, for the same reason as its
  // lower one.
  if (measure === "lit" && condition !== "toggles at") {
    const outside = [value, upper].some((amount) => amount !== null && (amount < 0 || amount > 1));
    if (outside) throw expectationError("Brightness runs from 0 to 1, so 0.5 is half lit.");
  }
  return { subject, measure, condition, value, upper, tolerance, from, until };
}

// How long a run has to be for an expectation to be answerable.
//
// A window says it outright. Without one there is nothing in the expectation
// that implies a length — except for a frequency, which implies exactly that:
// checking for 5Hz over 50ms cannot see a single cycle, and reporting "never
// switched" from that would be a false statement about the circuit rather than
// a true one about the run.
export function secondsNeededFor(expectation) {
  if (expectation.until !== null) return expectation.until;
  if (expectation.condition === "toggles at" && expectation.value > 0) {
    return expectation.from + (CYCLES_TO_SEE / expectation.value);
  }
  return expectation.from + DEFAULT_WINDOW_SECONDS;
}

// Enough cycles that a measured frequency means something, and a default long
// enough that an expectation with no window in it usually has something to
// judge. Neither can be right in every case, which is why `seconds` can be
// given and why a window that saw nothing says so.
const CYCLES_TO_SEE = 5;
const DEFAULT_WINDOW_SECONDS = 0.5;

// The points inside the expectation's window.
function windowOf(points, from, until) {
  return points.filter(([at]) => at >= from && (until === null || at <= until));
}

// How often the signal crosses the middle of its own range, in Hz.
//
// Measured against the midpoint between the extremes actually seen rather than
// a fixed threshold, so it works for a 5V logic pin and a 0.4V ripple alike.
// Hysteresis of a tenth of the swing on either side, because a noisy edge
// crossing a bare threshold three times counts as three edges and reports a
// frequency several times too high — which is the classic way a frequency
// counter lies.
function togglesPerSecond(points) {
  if (points.length < 4) return { hertz: 0, edges: 0 };
  const values = points.map(([, value]) => value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const swing = high - low;
  if (swing <= 1e-9) return { hertz: 0, edges: 0 };
  const middle = low + (swing / 2);
  const band = swing * 0.1;
  const rising = [];
  let above = values[0] > middle;
  for (const [at, value] of points) {
    if (!above && value > middle + band) { above = true; rising.push(at); continue; }
    if (above && value < middle - band) above = false;
  }
  if (rising.length < 2) return { hertz: 0, edges: rising.length };
  // Across the whole span rather than between neighbouring edges: one period
  // measured off two adjacent samples inherits the whole of the sampling error,
  // and the traces are thinned, so that error can be large.
  const span = rising[rising.length - 1] - rising[0];
  return { hertz: span > 0 ? (rising.length - 1) / span : 0, edges: rising.length };
}

// Judge one expectation against the trace recorded for it.
//
// Returns the verdict, the figure it was judged on, and where in time that
// figure came from — a fault at 3ms and the same fault at 3s are different
// faults, and "failed" without the instant leaves that out.
export function checkExpectation(expectation, points) {
  const { subject, measure, condition, value, upper, tolerance, from, until } = expectation;
  const statement = describeExpectation(expectation);
  const inside = windowOf(points || [], from, until);

  const figure = (amount) => formatMeasure(measure, amount);

  if (!inside.length) {
    return {
      ...expectation, statement, pass: false, measured: null, at: null,
      detail: until === null
        ? `Nothing was recorded for ${subject}. Run the circuit for longer than ${formatSeconds(from)}.`
        : `Nothing was recorded for ${subject} between ${formatSeconds(from)} and ${formatSeconds(until)}.`
    };
  }

  const extreme = (pick) => inside.reduce((best, point) => (pick(point[1], best[1]) ? point : best), inside[0]);
  const highest = extreme((candidate, best) => candidate > best);
  const lowest = extreme((candidate, best) => candidate < best);

  switch (condition) {
    case "never above": {
      const pass = highest[1] <= value;
      return {
        ...expectation, statement, pass, measured: highest[1], at: highest[0],
        detail: pass
          ? `Peaked at ${figure(highest[1])} at ${formatSeconds(highest[0])}, under the ${figure(value)} limit.`
          : `Reached ${figure(highest[1])} at ${formatSeconds(highest[0])}, which is ${figure(highest[1] - value)} over the limit.`
      };
    }
    case "never below": {
      const pass = lowest[1] >= value;
      return {
        ...expectation, statement, pass, measured: lowest[1], at: lowest[0],
        detail: pass
          ? `Held at or above ${figure(lowest[1])}, its lowest, at ${formatSeconds(lowest[0])}.`
          : `Dropped to ${figure(lowest[1])} at ${formatSeconds(lowest[0])}, ${figure(value - lowest[1])} below the floor.`
      };
    }
    case "reaches": {
      const hit = inside.find(([, amount]) => amount >= value);
      return {
        ...expectation, statement, pass: Boolean(hit), measured: hit ? hit[1] : highest[1], at: hit ? hit[0] : highest[0],
        detail: hit
          ? `Got to ${figure(hit[1])} at ${formatSeconds(hit[0])}.`
          // The best it managed is the useful number: it says whether this is a
          // circuit that is slightly short or one that is not working at all.
          : `Never got there. The most it managed was ${figure(highest[1])}, at ${formatSeconds(highest[0])}.`
      };
    }
    case "stays between": {
      const below = lowest[1] < value;
      const above = highest[1] > upper;
      const pass = !below && !above;
      const offender = below ? lowest : highest;
      return {
        ...expectation, statement, pass, measured: offender[1], at: offender[0],
        detail: pass
          ? `Stayed between ${figure(lowest[1])} and ${figure(highest[1])}, inside the band.`
          : `Went ${below ? "below" : "above"} the band, to ${figure(offender[1])} at ${formatSeconds(offender[0])}.`
      };
    }
    case "averages": {
      const mean = inside.reduce((total, [, amount]) => total + amount, 0) / inside.length;
      const pass = Math.abs(mean - value) <= tolerance;
      return {
        ...expectation, statement, pass, measured: mean, at: null,
        detail: pass
          ? `Averaged ${figure(mean)} over ${inside.length} samples.`
          : `Averaged ${figure(mean)}, which is ${figure(Math.abs(mean - value))} away from ${figure(value)}.`
      };
    }
    case "toggles at": {
      const { hertz, edges } = togglesPerSecond(inside);
      const pass = edges >= 2 && Math.abs(hertz - value) <= tolerance;
      // Not seeing a cycle and there not being one are different findings, and
      // only one of them is about the circuit. A run too short to hold two
      // periods cannot say the signal never switched, so it says what it
      // actually knows: that it did not look for long enough.
      const span = inside[inside.length - 1][0] - inside[0][0];
      const tooShort = edges < 2 && value > 0 && span < (2 / value);
      return {
        ...expectation, statement, pass, measured: hertz, at: null,
        detail: tooShort
          ? `The run only covered ${formatSeconds(span)}, which is less than two cycles at ${value}Hz. Run for longer to tell.`
          : edges < 2
          ? `Never switched — it sat between ${figure(lowest[1])} and ${figure(highest[1])} the whole time.`
          : pass
            ? `Switched at ${hertz.toFixed(2)}Hz over ${edges} edges.`
            : `Switched at ${hertz.toFixed(2)}Hz, not ${value}Hz. That is ${(hertz / value).toFixed(2)}× the rate asked for.`
      };
    }
    default:
      return { ...expectation, statement, pass: false, measured: null, at: null, detail: `Evolv does not know how to check "${condition}".` };
  }
}

// The whole set, and a sentence about how it went.
//
// The summary leads with what failed, because a report whose first line is
// "6 of 7 passed" buries the only line anyone needed to read.
export function summarise(results) {
  const failed = results.filter((result) => !result.pass);
  if (!results.length) return "Nothing has been expected of this circuit yet.";
  if (!failed.length) {
    return `All ${results.length} expectation${results.length === 1 ? "" : "s"} met.`;
  }
  const first = failed[0];
  return `${failed.length} of ${results.length} not met. ${first.statement} — ${first.detail}`;
}
