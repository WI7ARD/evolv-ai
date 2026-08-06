// Canvas renderer for the sandbox world.
//
// It draws whatever /api/sandboxes/:id/world returns and nothing else. There
// is no animation loop inventing motion, no progress bar counting up on a
// timer, and no idle fidget: a frame is drawn when the state it depends on
// actually changed. If the sprite looks like it is testing, a check is really
// running. Anything else would be a lie told by the one part of the product
// that is meant to make work legible.

const COLORS = {
  staged: "#c9d24b", checked: "#6fd08c", failing: "#e2685f",
  passed: "#6fd08c", failed: "#e2685f",
  project: "#8ea2c6", agent: "#f2f2f2", zone: "rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.16)"
};

const SPRITE_FACES = {
  idle: "•  •", planning: "•  •", coding: "•  •", testing: "•  •",
  celebrating: "^  ^", error: "x  x"
};

const state = { api: null, sessionId: "", view: null, enabled: true };

function scale(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = canvas.clientHeight || 320;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawSprite(context, x, y, spriteState) {
  context.fillStyle = COLORS.agent;
  context.beginPath();
  context.roundRect(x - 11, y - 13, 22, 24, 6);
  context.fill();
  context.fillStyle = "#11150d";
  context.font = "9px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText(SPRITE_FACES[spriteState] || SPRITE_FACES.idle, x, y - 1);
  // A single state pip, not an animation.
  context.fillStyle = spriteState === "error" ? COLORS.failing : spriteState === "celebrating" ? COLORS.checked : COLORS.staged;
  context.beginPath();
  context.arc(x, y + 7, 2.5, 0, Math.PI * 2);
  context.fill();
}

export function renderWorld() {
  const canvas = document.querySelector("#world-canvas");
  if (!canvas || !state.enabled) return;
  const { context, width, height } = scale(canvas);
  context.clearRect(0, 0, width, height);
  const view = state.view;
  if (!view) {
    context.fillStyle = "rgba(255,255,255,0.4)";
    context.font = "12px ui-sans-serif, system-ui";
    context.textAlign = "center";
    context.fillText("Open a simulation to see it here.", width / 2, height / 2);
    return;
  }
  const toX = (value) => (value / 100) * width;
  const toY = (value) => (value / 100) * height;

  for (const zone of view.zones) {
    context.fillStyle = COLORS.zone;
    context.fillRect(toX(zone.x) + 4, toY(zone.y) + 4, toX(zone.width) - 8, toY(zone.height) - 8);
    context.fillStyle = "rgba(255,255,255,0.35)";
    context.font = "10px ui-monospace, monospace";
    context.textAlign = "left";
    context.fillText(zone.label.toUpperCase(), toX(zone.x) + 12, toY(zone.y) + 20);
  }

  const byId = new Map(view.objects.map((object) => [object.id, object]));
  context.strokeStyle = COLORS.line;
  context.lineWidth = 1;
  for (const link of view.relationships) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) continue;
    context.beginPath();
    context.moveTo(toX(from.position.x), toY(from.position.y));
    context.lineTo(toX(to.position.x), toY(to.position.y));
    context.stroke();
  }

  for (const object of view.objects) {
    const x = toX(object.position.x);
    const y = toY(object.position.y);
    if (object.type === "agent") { drawSprite(context, x, y, object.state); continue; }
    context.fillStyle = COLORS[object.state] || COLORS.project;
    if (object.type === "project") {
      context.beginPath(); context.roundRect(x - 14, y - 10, 28, 20, 4); context.fill();
    } else if (object.type === "check") {
      context.beginPath(); context.arc(x, y, 7, 0, Math.PI * 2); context.fill();
    } else {
      context.beginPath(); context.roundRect(x - 9, y - 11, 18, 22, 3); context.fill();
    }
    context.fillStyle = "rgba(255,255,255,0.72)";
    context.font = "10px ui-monospace, monospace";
    context.textAlign = "center";
    const label = object.label.length > 22 ? `…${object.label.slice(-21)}` : object.label;
    context.fillText(label, x, y + 24);
  }

  const caption = document.querySelector("#world-caption");
  if (caption) {
    caption.textContent = `${view.sprite.label} · ${view.summary}${view.projectUntouched ? " · the project on disk is unchanged" : ""}`;
  }
  const skills = document.querySelector("#world-skills");
  if (skills) {
    skills.innerHTML = view.skills.map((skill) => `
      <span class="status-pill ${skill.available ? "ready" : ""}" title="${skill.summary.replace(/"/g, "&quot;")}">${skill.label}</span>
    `).join("");
  }
}

export async function showWorld(sessionId) {
  state.sessionId = sessionId;
  if (!state.api || !sessionId || !state.enabled) { state.view = null; renderWorld(); return; }
  try {
    state.view = await state.api(`/api/sandboxes/${encodeURIComponent(sessionId)}/world`);
  } catch {
    state.view = null;
  }
  renderWorld();
}

export function initWorld({ api }) {
  state.api = api;
  const toggle = document.querySelector("#world-enabled");
  if (toggle) {
    // The brief asks for the companion to be disableable. Honour it, and
    // remember the choice.
    state.enabled = localStorage.getItem("evolv.world.enabled") !== "false";
    toggle.checked = state.enabled;
    toggle.addEventListener("change", () => {
      state.enabled = toggle.checked;
      localStorage.setItem("evolv.world.enabled", String(state.enabled));
      document.querySelector("#world-panel")?.classList.toggle("hidden", !state.enabled);
      if (state.enabled) showWorld(state.sessionId);
    });
    document.querySelector("#world-panel")?.classList.toggle("hidden", !state.enabled);
  }
  window.addEventListener("resize", renderWorld);
}
