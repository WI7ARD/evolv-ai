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

const state = { api: null, toast: null, frame: null, circuit: null, busy: false, selected: "" };

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
  mcupin: "M14 6 L46 6 L46 34 L14 34 Z M46 20 L60 20 M20 6 L20 0 M28 6 L28 0 M36 6 L36 0 M20 34 L20 40 M28 34 L28 40"
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
    // Symbols are authored in a 60×40 box; the layout allots 60×40 too, so the
    // only transform needed is the move.
    return `<g class="circuit-symbol${state.selected === symbol.id ? " is-selected" : ""}" data-id="${escapeHtml(symbol.id)}"
      transform="translate(${symbol.x} ${symbol.y})">
      <rect class="circuit-hit" x="-4" y="-4" width="68" height="48" />
      <path class="circuit-glyph" d="${path}" />
      <text class="circuit-ref" x="30" y="-8">${escapeHtml(symbol.id)}</text>
      <text class="circuit-value" x="30" y="52">${escapeHtml(symbol.label)}</text>
      ${current !== undefined ? `<text class="circuit-current" x="30" y="64">${escapeHtml(amps(current))}</text>` : ""}
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
    const unit = trace.kind === "net" ? volts : amps;
    return `<figure class="circuit-trace">
      <figcaption>${escapeHtml(trace.target)} <span>${escapeHtml(trace.kind === "net" ? "voltage" : "current")}</span></figcaption>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
        aria-label="${escapeHtml(trace.target)} from ${escapeHtml(unit(low))} to ${escapeHtml(unit(high))}">
        <path class="circuit-trace-line" d="${path}" />
      </svg>
      <div class="circuit-trace-scale">
        <span>${escapeHtml(unit(high))}</span>
        <span>${escapeHtml(seconds(startTime))} → ${escapeHtml(seconds(endTime))}</span>
        <span>${escapeHtml(unit(low))}</span>
      </div>
    </figure>`;
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
  const parts = $("#circuit-parts");
  if (parts) parts.innerHTML = renderParts(state.circuit);
  const bom = $("#circuit-bom");
  if (bom) bom.innerHTML = renderBom(state.circuit);
  const traces = $("#circuit-traces");
  if (traces) traces.innerHTML = renderTraces(state.frame);
  const clock = $("#circuit-time");
  if (clock) {
    const elapsed = state.frame?.elapsedSeconds || 0;
    clock.textContent = elapsed > 0 ? `t = ${seconds(elapsed)}` : "not run yet";
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
    await state.api("/api/circuit/actions", { method: "POST", body: { action, ...parameters } });
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
    const result = await state.api("/api/circuit/run", { method: "POST", body: { seconds: secondsToRun } });
    if (result.ran === false) state.toast?.("The circuit could not be run — see the findings below.");
    await refreshCircuit();
  } catch (error) {
    state.toast?.(error.message || "The run did not finish.");
  } finally {
    state.busy = false;
  }
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
  $("#circuit-rewind")?.addEventListener("click", async () => {
    try {
      await state.api("/api/circuit/rewind", { method: "POST", body: {} });
      await refreshCircuit();
    } catch (error) {
      state.toast?.(error.message || "Could not rewind.");
    }
  });
  $("#circuit-probe-add")?.addEventListener("click", async () => {
    const target = $("#circuit-probe-target")?.value?.trim();
    if (!target) return;
    try {
      await state.api("/api/circuit/probes", { method: "POST", body: { target } });
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
