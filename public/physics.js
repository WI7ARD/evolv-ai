// The physics sandbox view.
//
// This file draws and nothing else. The world is solved in the server, so what
// arrives here is a list of already-rotated polygons; the page has no engine,
// no geometry, and no opinion about what should happen next. That is what lets
// a person and a model watch the same scene instead of two that look alike.
//
// Time only advances while the loop is running, and the loop is a button. A
// sandbox that keeps simulating in a background tab burns a laptop battery to
// show nobody anything.

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, running: false, timer: null, frame: null, selected: "", busy: false
};

const COLOURS = {
  box: "#bdff47", circle: "#7ad7ff", ramp: "#8b93a1", motor: "#ffb347"
};

function draw() {
  const canvas = $("#physics-canvas");
  const frame = state.frame;
  if (!canvas || !frame) return;
  const context = canvas.getContext("2d");
  const { width, height } = frame.world;

  // Backing store at device resolution, drawing in world units. Without this
  // the whole scene is soft on any HiDPI screen.
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || width;
  const scale = cssWidth / width;
  const cssHeight = height * scale;
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.height = `${cssHeight}px`;
  }
  context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
  context.clearRect(0, 0, width, height);

  context.fillStyle = "#0d1013";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(189,255,71,0.10)";
  context.lineWidth = 1;
  for (let x = 50; x < width; x += 50) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  for (let y = 50; y < height; y += 50) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  // The floor, so falling objects visibly land on something.
  context.strokeStyle = "rgba(189,255,71,0.35)";
  context.lineWidth = 2;
  context.beginPath(); context.moveTo(0, height - 1); context.lineTo(width, height - 1); context.stroke();

  for (const body of frame.bodies) {
    const colour = COLOURS[body.kind] || COLOURS.box;
    const isSelected = body.id === state.selected;
    context.beginPath();
    if (body.circleRadius) {
      context.arc(body.x, body.y, body.circleRadius, 0, Math.PI * 2);
      // A spoke, so a spinning wheel reads as spinning rather than as a disc.
      context.moveTo(body.x, body.y);
      context.lineTo(
        body.x + Math.cos(body.angle) * body.circleRadius,
        body.y + Math.sin(body.angle) * body.circleRadius
      );
    } else {
      body.vertices.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
      context.closePath();
    }
    context.fillStyle = `${colour}${body.fixed ? "22" : "33"}`;
    context.fill();
    context.strokeStyle = isSelected ? "#ffffff" : colour;
    context.lineWidth = isSelected ? 2.5 : 1.5;
    context.stroke();
  }

  const caption = $("#physics-caption");
  if (caption) {
    caption.textContent = frame.bodies.length === 0
      ? "Empty scene. Drop something in."
      : `${frame.bodies.length} object(s) · gravity ${frame.gravity} · ${frame.elapsedSeconds}s simulated`;
  }
}

async function refreshFrame() {
  state.frame = await state.api("/api/physics/frame");
  draw();
}

// One request per tick carries the step and returns the frame, so the picture
// can never be a step behind what the world has already done.
async function tick() {
  if (!state.running) return;
  try {
    const result = await state.api("/api/physics/step", { method: "POST", body: JSON.stringify({ steps: 2 }) });
    state.frame = result.frame;
    draw();
  } catch (error) {
    stop();
    state.toast(error.message, "error");
  }
}

function start() {
  if (state.running) return;
  state.running = true;
  state.timer = setInterval(tick, 33);
  const button = $("#physics-play");
  if (button) button.textContent = "Pause";
}

function stop() {
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const button = $("#physics-play");
  if (button) button.textContent = "Run";
}

async function act(action, parameters = {}) {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await state.api("/api/physics/actions", {
      method: "POST", body: JSON.stringify({ action, ...parameters })
    });
    state.frame = null;
    await refreshFrame();
    return result;
  } catch (error) {
    state.toast(error.message, "error");
    return null;
  } finally {
    state.busy = false;
  }
}

// Dropped objects land somewhere slightly different each time, so a second
// click builds a pile instead of stacking one object on its own centre line.
const scatter = () => 150 + Math.random() * 500;

export function initPhysics({ api, toast }) {
  state.api = api;
  state.toast = toast;

  $("#physics-add-box")?.addEventListener("click", () => act("create_box", { x: scatter(), y: 60, width: 50, height: 50 }));
  $("#physics-add-circle")?.addEventListener("click", () => act("create_circle", { x: scatter(), y: 60, radius: 30 }));
  $("#physics-add-motor")?.addEventListener("click", () => act("create_motor", { x: scatter(), y: 200, radius: 40, speed: 0.25 }));
  $("#physics-add-ramp")?.addEventListener("click", () => act("create_ramp", { x: scatter(), y: 400, width: 300, height: 20, angle: 0.3 }));
  $("#physics-clear")?.addEventListener("click", async () => {
    state.selected = "";
    await act("clear");
    $("#physics-readout").textContent = "";
  });

  $("#physics-play")?.addEventListener("click", () => (state.running ? stop() : start()));
  $("#physics-gravity")?.addEventListener("change", (event) => {
    act("set_gravity", { gravity: Number(event.target.value) });
  });

  // Clicking an object asks the server what is there, so selection agrees with
  // the simulation rather than with a guess made from the drawing.
  $("#physics-canvas")?.addEventListener("click", async (event) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scale = (state.frame?.world.width || 800) / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const y = (event.clientY - rect.top) * scale;
    try {
      const { object } = await state.api(`/api/physics/at?x=${x.toFixed(1)}&y=${y.toFixed(1)}`);
      state.selected = object?.id || "";
      $("#physics-readout").textContent = object
        ? `${object.id} · ${object.fixed ? "fixed" : `mass ${object.mass}`} · at (${object.x}, ${object.y}) · speed ${object.speed}${object.resting ? " · resting" : ""}`
        : "";
      draw();
    } catch (error) {
      state.toast(error.message, "error");
    }
  });

  window.addEventListener("resize", draw);
}

export async function refreshPhysics() {
  await refreshFrame();
}

// Leaving the view must stop the clock. Otherwise the scene keeps stepping,
// and every request it makes is work nobody asked for.
export function suspendPhysics() {
  stop();
}
