// The circuit sandbox, drawn.
//
// This file computes nothing. Every voltage, current and finding on the page
// came from the server, which is where the solver lives — the same discipline
// public/physics.js follows, and for the same reason: if the page did its own
// arithmetic there would be two answers to every question, and no way to know
// which one a model was looking at.
//
// What it does own is the drawing: IEEE-style symbols, orthogonal wires, and
// the numbers written beside them.

const $ = (selector) => document.querySelector(selector);

const state = { api: null, toast: null, frame: null, circuit: null, checks: null, busy: false, selected: "" };

export function initCircuit({ api, toast }) {
  state.api = api;
  state.toast = toast;
}

// Symbols, as line drawings in the part's own 60×40 box.
//
// Drawn rather than imported: a schematic symbol is a dozen line segments, and
// an icon font or an SVG sprite sheet would be a dependency and a licence for
// something this small. Each returns SVG path data in local coordinates.
const SYMBOLS = {
  resistor: "M0 20 L10 20 L14 10 L22 30 L30 10 L38 30 L46 10 L50 20 L60 20",
  capacitor: "M0 20 L26 20 M26 5 L26 35 M34 5 L34 35 M34 20 L60 20",
  inductor: "M0 20 L12 20 A6 6 0 0 1 24 20 A6 6 0 0 1 36 20 A6 6 0 0 1 48 20 L60 20",
  battery: "M0 20 L22 20 M22 8 L22 32 M30 14 L30 26 M30 20 L60 20 M38 8 L38 32 M46 14 L46 26",
  supply: "M0 20 L20 20 M30 20 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 M40 20 L60 20",
  ground: "M30 0 L30 14 M18 14 L42 14 M22 20 L38 20 M26 26 L34 26",
  diode: "M0 20 L22 20 M22 8 L22 32 L40 20 Z M40 8 L40 32 M40 20 L60 20",
  led: "M0 20 L22 20 M22 8 L22 32 L40 20 Z M40 8 L40 32 M40 20 L60 20 M44 4 L52 -4 M50 8 L58 0",
  switch: "M0 20 L18 20 M18 20 L40 8 M42 20 L60 20 M18 20 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M42 20 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
  potentiometer: "M0 20 L10 20 L14 10 L22 30 L30 10 L38 30 L46 10 L50 20 L60 20 M30 40 L30 30 M26 32 L30 26 L34 32",
  // The chips. A triangle for anything that amplifies or buffers, a box for
  // anything with state — which is the convention every schematic follows and
  // the reason you can read one at a glance without labels.
  opamp: "M14 4 L14 36 L46 20 Z M0 12 L14 12 M0 28 L14 28 M46 20 L60 20 M30 8 L30 4 M30 36 L30 32",
  regulator: "M8 8 L52 8 L52 32 L8 32 Z M0 20 L8 20 M52 20 L60 20 M30 32 L30 40",
  gate: "M14 4 L14 36 L46 20 Z M0 12 L14 12 M0 28 L14 28 M50 20 L60 20 M46 20 m0 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0",
  flipflop: "M10 2 L50 2 L50 38 L10 38 Z M0 10 L10 10 M0 20 L10 20 M50 12 L60 12 M50 28 L60 28 M10 26 L18 20 L10 14",
  timer555: "M10 2 L50 2 L50 38 L10 38 Z M0 8 L10 8 M0 20 L10 20 M0 32 L10 32 M50 20 L60 20 M22 14 L38 14 M22 20 L38 20 M22 26 L38 26",
  mcupin: "M14 6 L46 6 L46 34 L14 34 Z M46 20 L60 20 M20 6 L20 0 M28 6 L28 0 M36 6 L36 0 M20 34 L20 40 M28 34 L28 40",
  // Outputs. The motor is the circled M every schematic uses; the rotor line
  // inside it is drawn separately so it can turn.
  motor: "M0 20 L12 20 M48 20 L60 20 M30 20 m-18 0 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0",
  servo: "M0 20 L10 20 M10 8 L38 8 L38 32 L10 32 Z M38 20 L44 20 M44 20 m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0",
  buzzer: "M0 20 L14 20 M14 10 L14 30 M14 20 L30 8 L30 32 Z M38 12 a10 10 0 0 1 0 16 M44 8 a16 16 0 0 1 0 24 M30 20 L60 20",
  rgbled: "M0 20 L22 20 M22 8 L22 32 L40 20 Z M40 8 L40 32 M40 20 L60 20 M44 4 L52 -4 M50 8 L58 0 M12 8 L12 32",
  mcu: "M10 0 L50 0 L50 40 L10 40 Z M10 6 L4 6 M10 14 L4 14 M10 22 L4 22 M10 30 L4 30 M50 6 L56 6 M50 14 L56 14 M50 22 L56 22 M50 30 L56 30 M18 8 L18 14 M22 8 L22 14",
  sevenseg: "M8 2 L52 2 L52 38 L8 38 Z M16 8 L44 8 M16 20 L44 20 M16 32 L44 32 M16 8 L16 20 M16 20 L16 32 M44 8 L44 20 M44 20 L44 32"
};

// Colours an LED actually glows, so a lit green LED is green.
const LED_COLOURS = {
  red: "#ff4d4d", green: "#4dff88", yellow: "#ffd24d", blue: "#4db8ff", white: "#eaf4ff"
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

// Three significant figures, in the units a person would say them in.
function volts(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (Math.abs(number) < 0.1 && number !== 0) return `${(number * 1000).toPrecision(3)}mV`;
  return `${Number(number.toPrecision(3))}V`;
}

function amps(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const size = Math.abs(number);
  if (size === 0) return "0A";
  if (size < 1e-6) return `${Number((number * 1e9).toPrecision(3))}nA`;
  if (size < 1e-3) return `${Number((number * 1e6).toPrecision(3))}µA`;
  if (size < 1) return `${Number((number * 1e3).toPrecision(3))}mA`;
  return `${Number(number.toPrecision(3))}A`;
}

function renderSchematic(frame) {
  if (!frame?.symbols?.length) {
    return `<p class="circuit-empty">Nothing here yet. Ask for a circuit — "an LED on 5V" — or add a part from the toolbar.</p>`;
  }
  const wires = frame.wires.map((wire) => {
    const points = wire.points.map(([x, y]) => `${x},${y}`).join(" ");
    const classes = ["circuit-wire", wire.dangling ? "is-dangling" : "", wire.spine ? "is-spine" : ""].filter(Boolean).join(" ");
    return `<polyline class="${classes}" points="${points}" />`;
  }).join("");

  const dots = frame.junctions.map((dot) => `<circle class="circuit-junction" cx="${dot.x}" cy="${dot.y}" r="3" />`).join("");

  const symbols = frame.symbols.map((symbol) => {
    const path = SYMBOLS[symbol.symbol] || SYMBOLS.resistor;
    const current = frame.currents?.[symbol.id];
    const device = frame.devices?.[symbol.id];
    // Symbols are authored in a 60×40 box; the layout allots 60×40 too, so the
    // only transform needed is the move.
    return `<g class="circuit-symbol${state.selected === symbol.id ? " is-selected" : ""}" data-id="${escapeHtml(symbol.id)}"
      transform="translate(${symbol.x} ${symbol.y})">
      <rect class="circuit-hit" x="-4" y="-4" width="68" height="48" />
      ${renderDevice(symbol, device)}
      <path class="circuit-glyph" d="${path}" />
      <text class="circuit-ref" x="30" y="-8">${escapeHtml(symbol.id)}</text>
      <text class="circuit-value" x="30" y="52">${escapeHtml(symbol.label)}</text>
      ${current !== undefined ? `<text class="circuit-current" x="30" y="64">${escapeHtml(amps(current))}</text>` : ""}
      ${device ? `<text class="circuit-device" x="30" y="76">${escapeHtml(deviceCaption(symbol.kind, device))}</text>` : ""}
    </g>`;
  }).join("");

  // Net voltages, written once per net at the top of its spine.
  // Anchors come from the layout, which knows whether a net has a channel of
  // its own. A label on a vertical channel is turned on its side, because laid
  // flat it is as wide as three symbols and lands on whichever one shares its
  // row.
  const labels = (frame.labels || []).map((label) => {
    const value = frame.nets?.[label.net];
    const caption = frame.solved && value !== undefined ? `${label.net} ${volts(value)}` : label.net;
    const turn = label.vertical ? ` transform="rotate(-90 ${label.x} ${label.y})"` : "";
    return `<text class="circuit-net" x="${label.x}" y="${label.y}"${turn}>${escapeHtml(caption)}</text>`;
  }).join("");

  return `<svg class="circuit-canvas" viewBox="0 0 ${frame.width + 60} ${frame.height + 40}" role="img"
    aria-label="Circuit schematic with ${frame.symbols.length} parts">${wires}${dots}${symbols}${labels}</svg>`;
}

// What each kind of probe is measuring, and in what. A motor's speed shown in
// amps read "5310A", which is not a small formatting slip — it is a number
// nobody could reconcile with anything.
const TRACE_UNITS = {
  net: volts,
  part: amps,
  speed: (value) => `${Math.round(Number(value) || 0)} rpm`,
  angle: (value) => `${(Number(value) || 0).toFixed(1)}°`,
  // Brightness runs 0 to 1. Left out of this table it fell through to amps and
  // a two-thirds-lit LED was labelled "660mA" — thirty times its rating, on a
  // part drawing 7.94mA two plots further down. Exactly the fault the comment
  // above describes, made again.
  lit: (value) => `${Math.round((Number(value) || 0) * 100)}%`
};
const TRACE_LABELS = { net: "voltage", part: "current", speed: "speed", angle: "angle", lit: "brightness" };

function seconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const size = Math.abs(number);
  if (size === 0) return "0s";
  if (size < 1e-6) return `${Number((number * 1e9).toPrecision(3))}ns`;
  if (size < 1e-3) return `${Number((number * 1e6).toPrecision(3))}µs`;
  if (size < 1) return `${Number((number * 1e3).toPrecision(3))}ms`;
  return `${Number(number.toPrecision(3))}s`;
}

// The traces, as one plot per probe.
//
// One plot each rather than all of them on shared axes: a net at 5V and a
// current at 13mA on the same scale means the current is a flat line on the
// axis, which is worse than not drawing it. Each keeps its own range and says
// what that range is.
function renderTraces(frame) {
  const traces = frame?.traces || [];
  if (!traces.length) {
    return `<p class="settings-note">No probes yet. Watch a net or a part — <code>circuit_probe</code>, or ask for it — then run.</p>`;
  }
  const width = 640;
  const height = 120;
  return traces.map((trace) => {
    const points = trace.points || [];
    if (points.length < 2) {
      return `<figure class="circuit-trace"><figcaption>${escapeHtml(trace.target)} — nothing recorded yet</figcaption></figure>`;
    }
    const times = points.map(([time]) => time);
    const values = points.map(([, value]) => value);
    const startTime = Math.min(...times);
    const endTime = Math.max(...times);
    let low = Math.min(...values);
    let high = Math.max(...values);
    // A flat trace has no range to scale to, so give it one and centre it —
    // otherwise every point divides by zero and the line disappears.
    if (high - low < 1e-15) { high += 1; low -= 1; }
    const span = endTime - startTime || 1;
    const path = points.map(([time, value], index) => {
      const x = ((time - startTime) / span) * width;
      const y = height - (((value - low) / (high - low)) * height);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
    const unit = TRACE_UNITS[trace.kind] || amps;
    return `<figure class="circuit-trace">
      <figcaption>${escapeHtml(trace.target)} <span>${escapeHtml(TRACE_LABELS[trace.kind] || "current")}</span></figcaption>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
        aria-label="${escapeHtml(trace.target)} from ${escapeHtml(unit(low))} to ${escapeHtml(unit(high))}">
        <path class="circuit-trace-line" d="${path}" />
      </svg>
      <div class="circuit-trace-scale">
        <span>${escapeHtml(unit(high))}</span>
        <span>${escapeHtml(seconds(startTime))} → ${escapeHtml(seconds(endTime))}${
          // Every trace is drawn full height, so a rail rippling by a fraction
          // of a millivolt looks exactly like a pin switching five volts. The
          // shape is honest and the axis was not: both ends read "5V" while the
          // line swung top to bottom, which reads as a supply collapsing.
          // Saying the swing is the difference between a plot you can trust and
          // one you have to already know the answer to read.
          unit(high) === unit(low) ? ` · swing ${escapeHtml(unit(high - low))}` : ""
        }</span>
        <span>${escapeHtml(unit(low))}</span>
      </div>
    </figure>`;
  }).join("");
}

// What an output is doing, drawn on top of its own symbol.
//
// The glow behind a lit LED, the rotor line in a spinning motor, the arm on a
// servo. None of this is computed here — brightness, rpm and angle all arrive
// from the server with the rest of the frame; this only decides where to put
// them.
function renderDevice(symbol, device) {
  if (!device) return "";
  if (symbol.kind === "led" || symbol.kind === "rgbled") {
    if (!device.lit) return "";
    const colour = LED_COLOURS[device.colour] || LED_COLOURS.red;
    // Radius as well as opacity, because a dim LED is small and faint on a
    // bench and only faint on a screen that scales one of the two.
    return `<circle class="circuit-glow" cx="31" cy="20" r="${(8 + (device.lit * 14)).toFixed(1)}"
      fill="${colour}" opacity="${(device.lit * 0.55).toFixed(3)}" />`;
  }
  if (symbol.kind === "motor") {
    // The rotor line, turned to where the shaft actually is. Turns come back
    // from the solver as a running total, so this is the real angle rather than
    // an animation loop that happens to look busy.
    const angle = ((device.turns || 0) * 360) % 360;
    return `<g transform="rotate(${angle.toFixed(2)} 30 20)">
      <line class="circuit-rotor" x1="30" y1="20" x2="30" y2="6" />
    </g>${device.stalled ? `<circle class="circuit-stalled" cx="30" cy="20" r="19" />` : ""}`;
  }
  if (symbol.kind === "servo") {
    // Zero degrees points left, 180 right, which is how a servo horn reads.
    return `<g transform="rotate(${(device.angle - 90).toFixed(1)} 44 20)">
      <line class="circuit-rotor" x1="44" y1="20" x2="44" y2="4" />
    </g>`;
  }
  if (symbol.kind === "buzzer" && device.frequency > 0) {
    return `<circle class="circuit-sounding" cx="30" cy="20" r="18" />`;
  }
  return "";
}

function deviceCaption(kind, device) {
  if (kind === "motor") return device.stalled ? `stalled · ${amps(device.amps)}` : `${device.rpm} rpm`;
  if (kind === "servo") return `${device.angle}°`;
  if (kind === "buzzer") return device.frequency ? `${device.frequency}Hz ${device.note}` : "silent";
  if (kind === "led" || kind === "rgbled") return device.lit ? `${Math.round(device.lit * 100)}% lit` : "dark";
  return "";
}

// Whether the circuit does what it was supposed to.
//
// The measured figure is on every line, passing or failing. A green tick with
// no number is a claim to be taken on trust; "peaked at 7.94mA, under the
// 20mA limit" is the reading itself, and it is the same amount of space.
function renderChecks(checks) {
  if (!checks?.results?.length) return "";
  return `<section class="circuit-checks">
    <p class="circuit-checks-summary is-${checks.failed ? "bad" : "good"}">${escapeHtml(checks.summary)}</p>
    <ul>${checks.results.map((result) => `<li class="circuit-check is-${result.pass ? "pass" : "fail"}">
      <span class="circuit-check-mark">${result.pass ? "held" : "failed"}</span>
      <span class="circuit-check-body">
        <strong>${escapeHtml(result.statement)}</strong>
        <span>${escapeHtml(result.detail)}</span>
      </span>
    </li>`).join("")}</ul>
  </section>`;
}

// What has been asked of the circuit but not yet checked, so a requirement
// written down is visible before anyone presses Check rather than only after.
function renderExpectations(circuit, checks) {
  const expectations = circuit?.expectations || [];
  if (!expectations.length || checks?.results?.length) return "";
  return `<section class="circuit-checks">
    <p class="circuit-checks-summary">${expectations.length} expectation${expectations.length === 1 ? "" : "s"}, not yet checked.</p>
    <ul>${expectations.map((expectation) => `<li class="circuit-check">
      <span class="circuit-check-mark">${escapeHtml(expectation.id)}</span>
      <span class="circuit-check-body"><strong>${escapeHtml(expectation.statement)}</strong></span>
    </li>`).join("")}</ul>
  </section>`;
}

// What a microcontroller is doing: its legs, and what it said.
//
// The pin table is limited to the pins this chip is actually wired to. A
// twelve-row table where nine rows read "input, 0.000V, not connected" buries
// the three that matter, and the interesting question is never what an unwired
// pin is up to.
//
// The printed output is the other half. A print statement is how anyone debugs
// firmware, and it is worth nothing if it goes somewhere you cannot see — so it
// is shown with the simulated time each line was printed at, which is a thing a
// real serial monitor cannot tell you.
function renderMcus(frame, circuit) {
  const chips = Object.entries(frame?.mcus || {});
  if (!chips.length) return "";
  return chips.map(([id, chip]) => {
    const wired = circuit?.parts?.find((part) => part.id === id)?.pins || {};
    const legs = Object.entries(chip.pins)
      .filter(([name]) => wired[name] && name !== "vcc" && name !== "gnd");
    const output = chip.output || [];
    return `<section class="circuit-mcu">
      <header class="circuit-mcu-head">
        <strong>${escapeHtml(id)}</strong>
        <span>${(chip.clockHz / 1e6).toFixed(0)}MHz</span>
        <span>${chip.iterations.toLocaleString()} loop${chip.iterations === 1 ? "" : "s"}</span>
      </header>
      ${chip.error ? `<p class="circuit-mcu-error">${escapeHtml(chip.error.message)}${
        chip.error.line ? ` (line ${chip.error.line})` : ""}</p>` : ""}
      ${legs.length ? `<table class="circuit-parts">
        <thead><tr><th>Pin</th><th>Wired to</th><th>Mode</th><th>Driving</th><th>Reads</th></tr></thead>
        <tbody>${legs.map(([name, pin]) => `<tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(wired[name])}</td>
          <td>${escapeHtml(pin.mode)}</td>
          <td>${escapeHtml(pin.driving || "—")}</td>
          <td>${pin.volts.toFixed(3)}V</td>
        </tr>`).join("")}</tbody>
      </table>` : ""}
      ${output.length ? `<pre class="circuit-serial">${output.map((entry) =>
        `${escapeHtml(seconds(entry.at).padStart(9))}  ${escapeHtml(entry.line)}`).join("\n")}</pre>` : ""}
    </section>`;
  }).join("");
}

function renderFindings(findings = []) {
  if (!findings.length) return "";
  return `<ul class="circuit-findings">${findings.map((finding) => `
    <li class="circuit-finding is-${escapeHtml(finding.severity)}">
      <strong>${escapeHtml(finding.component || finding.net || "Circuit")}</strong>
      ${escapeHtml(finding.message)}
    </li>`).join("")}</ul>`;
}

function renderParts(circuit) {
  if (!circuit?.parts?.length) return "";
  return `<table class="circuit-parts">
    <thead><tr><th>Part</th><th>Value</th><th>Connected to</th><th>Current</th></tr></thead>
    <tbody>${circuit.parts.map((part) => `<tr data-id="${escapeHtml(part.id)}">
      <td>${escapeHtml(part.id)}</td>
      <td>${escapeHtml(part.description)}</td>
      <td>${escapeHtml(Object.entries(part.pins).map(([pin, net]) => `${pin}→${net}`).join(", ") || "not connected")}</td>
      <td>${part.amps === undefined ? "" : escapeHtml(amps(part.amps))}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderBom(circuit) {
  if (!circuit?.billOfMaterials?.length) return "";
  return `<table class="circuit-bom">
    <thead><tr><th>Qty</th><th>Part</th><th>References</th></tr></thead>
    <tbody>${circuit.billOfMaterials.map((line) => `<tr>
      <td>${line.quantity}</td>
      <td>${escapeHtml(line.description)}</td>
      <td>${escapeHtml(line.references.join(", "))}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

export async function refreshCircuit() {
  if (!state.api) return;
  try {
    const [frame, circuit] = await Promise.all([
      state.api("/api/circuit/frame"),
      state.api("/api/circuit")
    ]);
    state.frame = frame;
    state.circuit = circuit;
    draw();
  } catch (error) {
    state.toast?.(error.message || "Could not read the circuit.");
  }
}

function draw() {
  const canvas = $("#circuit-schematic");
  if (canvas) canvas.innerHTML = renderSchematic(state.frame);
  const findings = $("#circuit-findings");
  if (findings) findings.innerHTML = renderFindings(state.circuit?.findings);
  const mcus = $("#circuit-mcus");
  if (mcus) mcus.innerHTML = renderMcus(state.frame, state.circuit);
  const checks = $("#circuit-checks");
  if (checks) checks.innerHTML = renderChecks(state.checks) || renderExpectations(state.circuit, state.checks);
  const parts = $("#circuit-parts");
  if (parts) parts.innerHTML = renderParts(state.circuit);
  const bom = $("#circuit-bom");
  if (bom) bom.innerHTML = renderBom(state.circuit);
  const traces = $("#circuit-traces");
  if (traces) traces.innerHTML = renderTraces(state.frame);
  const clock = $("#circuit-time");
  if (clock) {
    const elapsed = state.frame?.elapsedSeconds || 0;
    const rate = liveRunning() && liveRate < 0.9 ? ` · ${liveRate.toFixed(2)}× real time` : "";
    clock.textContent = elapsed > 0 ? `t = ${seconds(elapsed)}${rate}` : "not run yet";
  }
  const reading = $("#circuit-reading");
  if (reading) {
    // The drawing shows either a moment in a run or the state the circuit
    // settles to. Those are different claims, and a schematic that does not say
    // which is inviting the wrong one to be read off it.
    reading.textContent = state.frame?.reading === "instant"
      ? `Voltages and currents are at t = ${seconds(state.frame.elapsedSeconds)}. Everything here is solved on this computer.`
      : "Voltages are shown at each net, currents beside each part, once the circuit has settled. Everything here is solved on this computer.";
  }
  const status = $("#circuit-status");
  if (status) {
    const counts = state.circuit?.counts;
    status.textContent = counts
      ? `${counts.parts} part${counts.parts === 1 ? "" : "s"}, ${counts.nets} net${counts.nets === 1 ? "" : "s"}${state.circuit.solved ? "" : " — not solved"}`
      : "";
  }
}

async function act(action, parameters = {}) {
  if (state.busy) return;
  state.busy = true;
  try {
    await state.api("/api/circuit/actions", { method: "POST", body: JSON.stringify({ action, ...parameters }) });
    await refreshCircuit();
  } catch (error) {
    state.toast?.(error.message || "That did not work.");
  } finally {
    state.busy = false;
  }
}

async function runFor(secondsToRun) {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await state.api("/api/circuit/run", { method: "POST", body: JSON.stringify({ seconds: secondsToRun }) });
    if (result.ran === false) state.toast?.("The circuit could not be run — see the findings below.");
    await refreshCircuit();
  } catch (error) {
    state.toast?.(error.message || "The run did not finish.");
  } finally {
    state.busy = false;
  }
}

// Live: advance the simulation against the wall clock so an LED actually blinks
// and a motor actually turns.
//
// A bounded ticker calling the same run path everything else uses, never a
// second simulator — two simulators disagree, and the one on screen would be
// the one people believe. Each tick asks for the wall time that has genuinely
// passed, so a slow machine runs the circuit slowly rather than skipping.
let liveTimer = null;
let liveLast = 0;
// Bumped whenever live stops. A run already in flight when you press Stop still
// comes back, and without this its result was applied afterwards — the clock
// jumping a quarter of a second after you asked it to stop, which reads as the
// button not working.
let liveGeneration = 0;

export function liveRunning() {
  return liveTimer !== null;
}

function stopLive() {
  if (liveTimer !== null) clearTimeout(liveTimer);
  liveTimer = null;
  liveGeneration += 1;
  const button = $("#circuit-live");
  if (button) {
    button.textContent = "Live";
    button.setAttribute("aria-pressed", "false");
  }
}

async function liveTick() {
  if (liveTimer === null) return;
  const generation = liveGeneration;
  const now = Date.now();
  // A tick asks for the wall time that has genuinely passed, capped so a
  // backgrounded tab does not come back and demand ten seconds of simulation in
  // one go. The cap is small on purpose: a circuit with a fast timestep takes
  // longer to simulate than to happen, and asking for more than can be
  // delivered just makes each tick slower without making it more real.
  const elapsed = Math.min(0.05, Math.max(0.005, (now - liveLast) / 1000));
  liveLast = now;
  const started = Date.now();
  try {
    const result = await state.api("/api/circuit/run", { method: "POST", body: JSON.stringify({ seconds: elapsed }) });
    if (generation !== liveGeneration) return;
    if (result.ran === false) {
      stopLive();
      state.toast?.("The circuit could not be run — see the findings below.");
      return;
    }
    // How much of real time this is actually managing. A circuit whose timestep
    // is microseconds cannot run at the speed of the world, and saying "0.3×
    // real time" is honest where an unlabelled clock silently is not.
    const took = (Date.now() - started) / 1000;
    liveRate = took > 0 ? elapsed / took : 1;
    await refreshCircuit();
  } catch (error) {
    if (generation !== liveGeneration) return;
    stopLive();
    state.toast?.(error.message || "The live run stopped.");
    return;
  }
  if (liveTimer !== null && generation === liveGeneration) liveTimer = setTimeout(liveTick, 30);
}

let liveRate = 1;

export function suspendCircuit() {
  // The simulation must not keep running for a view nobody is looking at — the
  // same rule the physics sandbox follows.
  stopLive();
}

export function bindCircuitControls() {
  $("#circuit-add")?.addEventListener("click", async () => {
    const kind = $("#circuit-kind")?.value || "resistor";
    await act("add", { kind });
  });
  $("#circuit-clear")?.addEventListener("click", () => act("clear"));
  $("#circuit-run")?.addEventListener("click", () => {
    const asked = Number($("#circuit-seconds")?.value);
    runFor(Number.isFinite(asked) && asked > 0 ? asked : 0.1);
  });
  $("#circuit-live")?.addEventListener("click", () => {
    if (liveTimer !== null) {
      stopLive();
      return;
    }
    liveLast = Date.now();
    const button = $("#circuit-live");
    if (button) {
      button.textContent = "Stop";
      button.setAttribute("aria-pressed", "true");
    }
    liveTimer = setTimeout(liveTick, 60);
  });
  $("#circuit-rewind")?.addEventListener("click", async () => {
    stopLive();
    try {
      await state.api("/api/circuit/rewind", { method: "POST", body: "{}" });
      state.checks = null;
      await refreshCircuit();
    } catch (error) {
      state.toast?.(error.message || "Could not rewind.");
    }
  });
  $("#circuit-check")?.addEventListener("click", async () => {
    stopLive();
    if (state.busy) return;
    state.busy = true;
    try {
      state.checks = await state.api("/api/circuit/check", { method: "POST", body: "{}" });
      await refreshCircuit();
    } catch (error) {
      state.toast?.(error.message || "Nothing has been expected of this circuit yet.");
    } finally {
      state.busy = false;
    }
  });
  $("#circuit-probe-add")?.addEventListener("click", async () => {
    const target = $("#circuit-probe-target")?.value?.trim();
    if (!target) return;
    const measure = $("#circuit-probe-measure")?.value || "";
    try {
      await state.api("/api/circuit/probes", { method: "POST", body: JSON.stringify({ target, measure }) });
      $("#circuit-probe-target").value = "";
      await refreshCircuit();
    } catch (error) {
      state.toast?.(error.message || "Could not add that probe.");
    }
  });
  $("#circuit-refresh")?.addEventListener("click", refreshCircuit);
  // Selecting a part in the drawing highlights its row, and the reverse.
  $("#circuit-schematic")?.addEventListener("click", (event) => {
    const symbol = event.target.closest("[data-id]");
    state.selected = symbol ? symbol.dataset.id : "";
    draw();
  });
}

export { renderSchematic, renderTraces, volts, amps, seconds };
