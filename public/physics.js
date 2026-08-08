// The physics sandbox view.
//
// This file draws and nothing else. The world is solved in the server, so what
// arrives here is a list of already-rotated polygons; the page has no engine,
// no geometry beyond hit-testing a cursor, and no opinion about what should
// happen next. That is what lets a person and a model watch the same scene
// instead of two that look alike.
//
// Time only advances while the loop is running, and the loop is a button. A
// sandbox that keeps simulating in a background tab burns a laptop battery to
// show nobody anything.

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, running: false, timer: null, frame: null,
  selected: "", hovered: "", busy: false, deleting: false, pendingJoint: null,
  drag: null, swallowClick: false
};

// Each kind reads at a glance without a legend: machines warm, structure grey,
// figures pink, everything else the house acid green.
const COLOURS = {
  box: "#bdff47", circle: "#7ad7ff", triangle: "#c9a3ff", polygon: "#5ee9b5",
  star: "#ffd447", ramp: "#8b93a1", motor: "#ffb347", gear: "#ff8f5a",
  chain: "#9fb0c4", rope: "#d8c9a3", ragdoll: "#ff7ba8", car: "#6ad4ff"
};

// Where each kind wants to appear. Ramps belong low, hanging things high.
const DROP = {
  ramp: { y: 400, angle: 0.3 }, chain: { y: 70 }, rope: { y: 70 },
  motor: { y: 220 }, gear: { y: 220 }, car: { y: 120 }, ragdoll: { y: 90 }
};

const scatter = () => 160 + Math.random() * 480;

function worldPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scale = (state.frame?.world.width || 800) / rect.width;
  return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
}

// Hit-testing for hover happens here rather than over HTTP: a request per
// mouse move would be hundreds a second and the highlight would lag the
// cursor. Clicks still ask the server, which owns the truth.
function pointInPolygon(point, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if ((yi > point.y) !== (yj > point.y)
      && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bodyAt(point) {
  if (!state.frame) return "";
  // Reverse order so the object drawn on top is the one picked.
  for (let i = state.frame.bodies.length - 1; i >= 0; i -= 1) {
    const body = state.frame.bodies[i];
    if (body.circleRadius) {
      if (Math.hypot(point.x - body.x, point.y - body.y) <= body.circleRadius) return body.id;
    } else if (pointInPolygon(point, body.vertices)) return body.id;
  }
  return "";
}

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
  context.strokeStyle = "rgba(189,255,71,0.35)";
  context.lineWidth = 2;
  context.beginPath(); context.moveTo(0, height - 1); context.lineTo(width, height - 1); context.stroke();

  // Joints go under the bodies so a spring appears to enter the object rather
  // than lie across it.
  for (const link of frame.links || []) {
    const [ax, ay] = link.from;
    const [bx, by] = link.to;
    context.strokeStyle = link.springy ? "rgba(255,212,71,0.75)" : "rgba(159,176,196,0.6)";
    context.lineWidth = link.springy ? 2 : 1.5;
    context.beginPath();
    if (link.springy) {
      // A zigzag, because a straight line between two bodies reads as a rod.
      const coils = 12;
      const dx = (bx - ax) / coils;
      const dy = (by - ay) / coils;
      const nx = -(by - ay);
      const ny = bx - ax;
      const length = Math.hypot(nx, ny) || 1;
      context.moveTo(ax, ay);
      for (let i = 1; i < coils; i += 1) {
        const swing = (i % 2 === 0 ? 5 : -5);
        context.lineTo(ax + dx * i + (nx / length) * swing, ay + dy * i + (ny / length) * swing);
      }
      context.lineTo(bx, by);
    } else {
      context.moveTo(ax, ay);
      context.lineTo(bx, by);
    }
    context.stroke();
  }

  for (const body of frame.bodies) {
    const colour = COLOURS[body.kind] || COLOURS.box;
    const isSelected = body.id === state.selected;
    const isHovered = body.id === state.hovered;
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
    context.fillStyle = `${colour}${isHovered ? "55" : body.fixed ? "22" : "33"}`;
    context.fill();
    // In delete mode the highlight is red, so the cursor says what the click
    // will do before it does it.
    context.strokeStyle = isSelected ? "#ffffff"
      : isHovered ? (state.deleting ? "#ff4466" : "#ffffff")
        : colour;
    context.lineWidth = isSelected || isHovered ? 2.5 : 1.5;
    context.stroke();
  }

  const caption = $("#physics-caption");
  if (caption) {
    caption.textContent = frame.bodies.length === 0
      ? "Empty scene. Drop something in."
      : `${frame.bodies.length} part(s) · gravity ${frame.gravity}${frame.wind ? ` · wind ${frame.wind}` : ""} · ${frame.elapsedSeconds}s simulated`;
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
  if (state.busy) return null;
  state.busy = true;
  try {
    const result = await state.api("/api/physics/actions", {
      method: "POST", body: JSON.stringify({ action, ...parameters })
    });
    await refreshFrame();
    return result;
  } catch (error) {
    state.toast(error.message, "error");
    return null;
  } finally {
    state.busy = false;
  }
}

function material() {
  return $("#physics-material")?.value || "default";
}

function setDeleteMode(on) {
  state.deleting = on;
  state.pendingJoint = null;
  const button = $("#physics-delete-mode");
  if (button) {
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("active", on);
  }
  const canvas = $("#physics-canvas");
  if (canvas) canvas.classList.toggle("deleting", on);
  setJointHint();
}

function setJointHint(message = "") {
  const readout = $("#physics-readout");
  if (readout && message) readout.textContent = message;
}

// A joint needs two objects, so the button arms a mode and the next two clicks
// choose the ends. Doing it any other way would mean typing ids.
function armJoint(joint) {
  setDeleteMode(false);
  state.pendingJoint = { joint, first: "" };
  $("#physics-tools")?.querySelectorAll(".physics-joint").forEach((button) => {
    button.classList.toggle("active", button.dataset.joint === joint);
  });
  setJointHint(`${joint === "pin" ? "Pin joint" : "Spring"}: click the first object.`);
}

function disarmJoint() {
  state.pendingJoint = null;
  $("#physics-tools")?.querySelectorAll(".physics-joint").forEach((button) => button.classList.remove("active"));
}

async function handleCanvasClick(event) {
  const canvas = event.currentTarget;
  const point = worldPoint(event, canvas);
  const hit = bodyAt(point);

  if (state.deleting) {
    if (!hit) return;
    await act("remove", { id: hit });
    if (state.selected === hit) state.selected = "";
    setJointHint(`Removed ${hit}.`);
    return;
  }

  if (state.pendingJoint) {
    if (!hit) return;
    if (!state.pendingJoint.first) {
      state.pendingJoint.first = hit;
      state.selected = hit;
      setJointHint(`${state.pendingJoint.joint === "pin" ? "Pin joint" : "Spring"}: now click the second object.`);
      draw();
      return;
    }
    const { joint, first } = state.pendingJoint;
    if (first === hit) { setJointHint("Pick a different second object."); return; }
    const result = await act(joint === "pin" ? "connect_pin" : "connect_spring", { a: first, b: hit });
    disarmJoint();
    state.selected = "";
    if (result) setJointHint(`Connected ${first} to ${hit}.`);
    return;
  }

  // Plain selection asks the server, which owns mass, speed, and rest state.
  try {
    const { object } = await state.api(`/api/physics/at?x=${point.x.toFixed(1)}&y=${point.y.toFixed(1)}`);
    state.selected = object?.id || "";
    $("#physics-readout").textContent = object
      ? `${object.id}${object.material ? ` · ${object.material}` : ""} · ${object.fixed ? "fixed" : `mass ${object.mass}`}`
        + `${object.parts ? ` · ${object.parts} parts` : ""} · at (${object.x}, ${object.y}) · speed ${object.speed}${object.resting ? " · resting" : ""}`
      : "";
    draw();
  } catch (error) {
    state.toast(error.message, "error");
  }
}

// Dragging.
//
// The world is solved in the server, so a drag is a conversation, not a local
// mutation. A request per pointer event would queue up hundreds and the object
// would trail the cursor by whatever the backlog was, so only one is ever in
// flight: moves that arrive while a request is open overwrite a pending target
// and are sent as one when it returns. The cursor stays ahead, the object
// stays current, and nothing accumulates.
async function pump() {
  const drag = state.drag;
  if (!drag || drag.inFlight || !drag.pending) return;
  const target = drag.pending;
  drag.pending = null;
  drag.inFlight = true;
  try {
    const result = await state.api("/api/physics/drag", {
      method: "POST",
      body: JSON.stringify({ phase: "move", x: target.x, y: target.y, live: state.running })
    });
    // While the clock runs the render loop owns the frame; taking it here too
    // would fight it and show two positions a frame apart.
    if (!state.running) { state.frame = result.frame; draw(); }
  } catch (error) {
    state.toast(error.message, "error");
    endDrag();
    return;
  } finally {
    if (state.drag) state.drag.inFlight = false;
  }
  pump();
}

async function beginDrag(id, point, canvas, pointerId) {
  state.drag = { id, inFlight: false, pending: null, moved: false, from: point };
  canvas.setPointerCapture?.(pointerId);
  try {
    await state.api("/api/physics/drag", { method: "POST", body: JSON.stringify({ phase: "start", id, ...point }) });
  } catch (error) {
    state.drag = null;
    state.toast(error.message, "error");
  }
}

async function endDrag() {
  if (!state.drag) return;
  state.drag = null;
  try {
    const result = await state.api("/api/physics/drag", { method: "POST", body: JSON.stringify({ phase: "end" }) });
    if (!state.running) { state.frame = result.frame; draw(); }
  } catch { /* releasing a drag that already ended is not worth a toast */ }
}

// Saved scenes. The name field doubles as "save as": typing a new name creates
// a scene, reusing one overwrites it, which is what people expect from a name.
async function listScenes(selectId = "") {
  try {
    const { scenes } = await state.api("/api/physics/scenes");
    const list = $("#physics-scene-list");
    if (!list) return;
    const chosen = selectId || list.value;
    list.innerHTML = '<option value="">Saved scenes…</option>'
      + scenes.map((scene) => `<option value="${escapeAttribute(scene.id)}">${escapeAttribute(scene.name)} · ${scene.objectCount}</option>`).join("");
    if (chosen) list.value = chosen;
  } catch (error) {
    state.toast(error.message, "error");
  }
}

function escapeAttribute(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function saveScene() {
  const field = $("#physics-scene-name");
  const name = field?.value.trim();
  if (!name) {
    state.toast("Give the scene a name first.", "error");
    field?.focus();
    return;
  }
  try {
    const saved = await state.api("/api/physics/scenes", { method: "POST", body: JSON.stringify({ name }) });
    state.toast(`Saved “${saved.name}”.`);
    await listScenes(saved.id);
  } catch (error) {
    state.toast(error.message, "error");
  }
}

async function loadScene() {
  const id = $("#physics-scene-list")?.value;
  if (!id) { state.toast("Pick a saved scene first."); return; }
  stop();
  try {
    const result = await state.api(`/api/physics/scenes/${encodeURIComponent(id)}/load`, { method: "POST", body: "{}" });
    const field = $("#physics-scene-name");
    if (field) field.value = result.name;
    state.selected = "";
    await refreshFrame();
    state.toast(`Loaded “${result.name}”.`);
  } catch (error) {
    state.toast(error.message, "error");
  }
}

export function initPhysics({ api, toast }) {
  state.api = api;
  state.toast = toast;

  $("#physics-save")?.addEventListener("click", saveScene);
  $("#physics-load")?.addEventListener("click", loadScene);
  $("#physics-scene-delete")?.addEventListener("click", async () => {
    const list = $("#physics-scene-list");
    const id = list?.value;
    if (!id) { state.toast("Pick a saved scene first."); return; }
    try {
      await state.api(`/api/physics/scenes/${encodeURIComponent(id)}`, { method: "DELETE" });
      await listScenes("");
      state.toast("Scene deleted.");
    } catch (error) {
      state.toast(error.message, "error");
    }
  });
  $("#physics-reset")?.addEventListener("click", async () => {
    stop();
    try {
      await state.api("/api/physics/reset", { method: "POST", body: "{}" });
      await refreshFrame();
      state.toast("Back to the start.");
    } catch (error) {
      state.toast(error.message, "error");
    }
  });

  // Every drop button is the same handler; the kind is data, so adding one to
  // the page needs no code here.
  $("#physics-tools")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind], [data-joint]");
    if (!button) return;
    if (button.dataset.joint) { armJoint(button.dataset.joint); return; }
    disarmJoint();
    setDeleteMode(false);
    const kind = button.dataset.kind;
    const placement = DROP[kind] || {};
    act(`create_${kind}`, { x: scatter(), y: placement.y ?? 60, angle: placement.angle, material: material() });
  });

  $("#physics-play")?.addEventListener("click", () => (state.running ? stop() : start()));
  $("#physics-delete-mode")?.addEventListener("click", () => {
    disarmJoint();
    setDeleteMode(!state.deleting);
    setJointHint(state.deleting ? "Delete tool on. Click an object to remove it." : "");
  });
  $("#physics-clear")?.addEventListener("click", async () => {
    state.selected = "";
    disarmJoint();
    setDeleteMode(false);
    await act("clear");
    $("#physics-readout").textContent = "";
  });

  const slider = (id, action, key, output) => {
    const input = $(`#${id}`);
    input?.addEventListener("input", () => {
      const display = $(`#${output}`);
      if (display) display.textContent = Number(input.value).toFixed(1);
    });
    // The value is committed on release, not on every pixel of drag, so one
    // gesture is one request instead of fifty.
    input?.addEventListener("change", () => act(action, { [key]: Number(input.value) }));
  };
  slider("physics-gravity", "set_gravity", "gravity", "physics-gravity-value");
  slider("physics-wind", "set_wind", "wind", "physics-wind-value");

  const canvas = $("#physics-canvas");
  canvas?.addEventListener("click", (event) => {
    // A drag ends in a click event too. Swallowing it stops a drag that
    // happened to be in delete mode from also deleting what it just moved.
    if (state.swallowClick) { state.swallowClick = false; return; }
    handleCanvasClick(event);
  });

  canvas?.addEventListener("pointerdown", (event) => {
    // The other tools own the click: dragging must not steal it.
    if (state.deleting || state.pendingJoint || event.button !== 0) return;
    const point = worldPoint(event, canvas);
    const hit = bodyAt(point);
    if (!hit) return;
    event.preventDefault();
    canvas.style.cursor = "grabbing";
    beginDrag(hit, point, canvas, event.pointerId);
  });

  canvas?.addEventListener("pointermove", (event) => {
    const point = worldPoint(event, canvas);
    if (state.drag) {
      if (Math.hypot(point.x - state.drag.from.x, point.y - state.drag.from.y) > 3) state.drag.moved = true;
      state.drag.pending = point;
      pump();
      return;
    }
    const hit = bodyAt(point);
    if (hit === state.hovered) return;
    state.hovered = hit;
    canvas.style.cursor = hit ? (state.deleting ? "not-allowed" : "grab") : "crosshair";
    draw();
  });

  const finishDrag = () => {
    if (!state.drag) return;
    // Only a real movement swallows the click, so a plain click on an object
    // still selects it and reports its mass.
    state.swallowClick = state.drag.moved;
    canvas.style.cursor = state.hovered ? "grab" : "crosshair";
    endDrag();
  };
  canvas?.addEventListener("pointerup", finishDrag);
  canvas?.addEventListener("pointercancel", finishDrag);
  canvas?.addEventListener("pointerleave", () => {
    finishDrag();
    if (!state.hovered) return;
    state.hovered = "";
    draw();
  });

  window.addEventListener("resize", draw);
}

export async function refreshPhysics() {
  await Promise.all([refreshFrame(), listScenes()]);
}

// Leaving the view must stop the clock. Otherwise the scene keeps stepping,
// and every request it makes is work nobody asked for.
export function suspendPhysics() {
  stop();
}
