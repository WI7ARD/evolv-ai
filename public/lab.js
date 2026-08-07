// The lab display: a glass-cockpit view of time, weather, tasks, and a hand.
//
// It reuses the gesture recognizer the chat camera already loads rather than
// shipping a second one — two MediaPipe instances would mean two camera
// streams, and most webcams will simply refuse the second.
//
// Everything here is a read. The display shows what is already true and speaks
// it aloud on request; it never writes a task, never changes a setting, and
// never sends a frame anywhere. The camera is read in the page and discarded a
// frame later.

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, project: null, ensureRecognizer: null,
  recognizer: null, connections: null, stream: null, frame: null,
  clock: null, poll: null, lastGesture: 0, candidate: null,
  focus: 0, data: { tasks: [], weather: null }, running: false, speaking: false
};

// The order the focus ring walks. Each panel knows how to say itself.
const PANELS = ["time", "weather", "tasks", "system"];

function place() {
  return localStorage.getItem("evolv:lab-location") || "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function renderClock() {
  const now = new Date();
  const hours = now.getHours();
  const display = hours % 12 === 0 ? 12 : hours % 12;
  const clock = $("#lab-clock");
  if (clock) clock.textContent = `${pad(display)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${hours < 12 ? "AM" : "PM"}`;
  const date = $("#lab-date");
  if (date) {
    date.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
}

function renderCalendar() {
  const host = $("#lab-calendar");
  if (!host) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();

  const cells = [];
  for (const label of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) cells.push(`<span class="lab-cal-head">${label}</span>`);
  for (let blank = 0; blank < first; blank += 1) cells.push('<span class="lab-cal-day"></span>');
  for (let day = 1; day <= days; day += 1) {
    cells.push(`<span class="lab-cal-day${day === today ? " today" : ""}">${day}</span>`);
  }
  $("#lab-month").textContent = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  host.innerHTML = cells.join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function renderWeather() {
  const host = $("#lab-weather");
  if (!host) return;
  const weather = state.data.weather;
  if (!weather) {
    host.innerHTML = place()
      ? '<p class="lab-note">No reading yet.</p>'
      : '<p class="lab-note">Set a location below to show weather.</p>';
    return;
  }
  host.innerHTML = `
    <p class="lab-big">${Math.round(weather.temperature)}<span>${escapeHtml(weather.unit)}</span></p>
    <p class="lab-line">${escapeHtml(weather.conditions)}${weather.stale ? " · last known" : ""}</p>
    <p class="lab-note">${escapeHtml(weather.place)} · feels ${Math.round(weather.feelsLike)}${escapeHtml(weather.unit)}
      · wind ${Math.round(weather.windSpeed)} ${escapeHtml(weather.windUnit)}</p>
    <div class="lab-forecast">${weather.forecast.map((day) => `
      <div><strong>${new Date(`${day.date}T00:00`).toLocaleDateString(undefined, { weekday: "short" })}</strong>
      <span>${Math.round(day.high)}° / ${Math.round(day.low)}°</span></div>`).join("")}</div>`;
}

function renderTasks() {
  const host = $("#lab-tasks");
  if (!host) return;
  const tasks = state.data.tasks || [];
  host.innerHTML = tasks.length
    ? tasks.map((task) => `<li class="lab-task ${escapeHtml(task.status)}">${escapeHtml(task.title)}</li>`).join("")
    : '<li class="lab-note">Nothing open. Connect a project to see its tasks.</li>';
  $("#lab-task-count").textContent = String(tasks.length);
}

// The system panel is the "what am I" block: real facts about this machine and
// this build, not decoration. A panel that invents its contents would be the
// one thing on the display nobody could trust.
function renderSystem() {
  const host = $("#lab-system");
  if (!host) return;
  // Only things this panel can actually verify. A version number would need a
  // second literal kept in step by hand, which is the drift the rest of the
  // codebase already went out of its way to remove.
  const tasks = (state.data.tasks || []).length;
  const lines = [
    state.stream ? "Camera live · frames read here and discarded" : "Camera off",
    `${tasks} open task${tasks === 1 ? "" : "s"}`,
    state.data.weather
      ? `Weather via ${escapeHtml(state.data.weather.attribution || "Open-Meteo")}`
      : "Weather idle",
    "Conversations and feedback stay in local SQLite",
    "Nothing on this display leaves the computer"
  ];
  host.innerHTML = lines.map((line) => `<p>${line}</p>`).join("");
}

function renderFocus() {
  PANELS.forEach((name, index) => {
    $(`#lab-panel-${name}`)?.classList.toggle("focused", index === state.focus);
  });
  $("#lab-focus-name").textContent = PANELS[state.focus].toUpperCase();
}

// What the focused panel would say if asked. Kept separate from the markup so
// the spoken version reads as a sentence rather than as scraped labels.
function spokenSummary() {
  const now = new Date();
  if (PANELS[state.focus] === "time") {
    return `It is ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} on ${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`;
  }
  if (PANELS[state.focus] === "weather") {
    const weather = state.data.weather;
    if (!weather) return "No weather reading yet.";
    return `${weather.place}: ${Math.round(weather.temperature)} degrees and ${weather.conditions}, feels like ${Math.round(weather.feelsLike)}.`;
  }
  if (PANELS[state.focus] === "tasks") {
    const tasks = state.data.tasks || [];
    if (!tasks.length) return "Nothing is open.";
    return `${tasks.length} open task${tasks.length === 1 ? "" : "s"}. ${tasks.slice(0, 3).map((task) => task.title).join(". ")}.`;
  }
  return `Evolv is running locally. ${state.stream ? "The camera is on and frames stay on this computer." : "The camera is off."}`;
}

function speakFocused() {
  if (!("speechSynthesis" in window)) {
    state.toast("This system has no speech voices installed.", "error");
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spokenSummary());
  utterance.rate = 1;
  state.speaking = true;
  $("#lab-system-panel")?.classList.add("talking");
  utterance.onend = () => {
    state.speaking = false;
    $("#lab-system-panel")?.classList.remove("talking");
  };
  speechSynthesis.speak(utterance);
}

function silence() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.speaking = false;
  $("#lab-system-panel")?.classList.remove("talking");
}

async function refresh() {
  const parameters = new URLSearchParams();
  if (place()) parameters.set("location", place());
  const projectId = state.project()?.id;
  if (projectId) parameters.set("projectId", projectId);
  try {
    const payload = await state.api(`/api/hud?${parameters}`);
    state.data = { tasks: payload.tasks || [], weather: payload.weather };
    if (payload.weatherError && !payload.weather) $("#lab-weather").innerHTML = `<p class="lab-note">${escapeHtml(payload.weatherError)}</p>`;
    else renderWeather();
    renderTasks();
    renderSystem();
  } catch (error) {
    state.toast(error.message, "error");
  }
}

// The hand, drawn as a glowing skeleton inside a ring. Mirrored, because a
// display you stand in front of should move the way a mirror does.
function drawHand(landmarks) {
  const canvas = $("#lab-hand");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const size = canvas.width;
  context.clearRect(0, 0, size, size);

  context.strokeStyle = "rgba(93, 240, 205, 0.25)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(size / 2, size / 2, size * 0.46, 0, Math.PI * 2);
  context.stroke();

  if (!landmarks?.length) {
    context.fillStyle = "rgba(93, 240, 205, 0.4)";
    context.font = "16px system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(state.stream ? "Show a hand" : "Camera off", size / 2, size / 2);
    return;
  }

  const point = (mark) => ({ x: (1 - mark.x) * size, y: mark.y * size });
  context.shadowColor = "#5df0cd";
  context.shadowBlur = 14;
  context.strokeStyle = "#5df0cd";
  context.lineWidth = 2;
  for (const [from, to] of state.connections || []) {
    const a = point(landmarks[from]);
    const b = point(landmarks[to]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.fillStyle = "#eafff8";
  for (const mark of landmarks) {
    const at = point(mark);
    context.beginPath();
    context.arc(at.x, at.y, 3, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;
}

function act(name) {
  if (name === "Pointing_Up") {
    state.focus = (state.focus + 1) % PANELS.length;
    renderFocus();
    state.toast(`Focus: ${PANELS[state.focus]}`);
  } else if (name === "Thumb_Up") {
    speakFocused();
  } else if (name === "Closed_Fist") {
    silence();
  } else if (name === "Victory") {
    refresh();
    state.toast("Refreshing");
  }
}

function loop(now = performance.now()) {
  if (!state.stream) return;
  const video = $("#lab-video");
  if (now - (state.lastFrame || 0) >= 70 && video?.readyState >= 2) {
    state.lastFrame = now;
    try {
      const result = state.recognizer.recognizeForVideo(video, now);
      drawHand(result.landmarks?.[0]);

      const category = result.gestures?.[0]?.[0];
      const name = category?.categoryName || "None";
      $("#lab-gesture").textContent = name === "None" ? "—" : name.replaceAll("_", " ");
      if (name !== "None" && name !== "Open_Palm" && (category?.score || 0) >= 0.7) {
        // Held, not flickered: a gesture has to persist before it counts, and
        // then rate-limit itself, or a passing hand fires every action at once.
        if (state.candidate?.name !== name) state.candidate = { name, since: now };
        else if (now - state.candidate.since > 700 && now - state.lastGesture > 1800) {
          state.lastGesture = now;
          state.candidate = { name, since: now };
          act(name);
        }
      } else {
        state.candidate = null;
      }
    } catch { /* a dropped frame is not worth reporting */ }
  }
  state.frame = requestAnimationFrame(loop);
}

async function startCamera() {
  if (state.stream) return;
  const button = $("#lab-camera");
  button.disabled = true;
  try {
    const recognizer = await state.ensureRecognizer();
    state.recognizer = recognizer.recognizer;
    state.connections = recognizer.connections;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 } }, audio: false
    });
    const video = $("#lab-video");
    video.srcObject = state.stream;
    await video.play();
    button.textContent = "Stop camera";
    renderSystem();
    loop();
  } catch (error) {
    stopCamera();
    state.toast(`Camera: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function stopCamera() {
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = null;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  const video = $("#lab-video");
  if (video) video.srcObject = null;
  const button = $("#lab-camera");
  if (button) button.textContent = "Start camera";
  $("#lab-gesture").textContent = "—";
  drawHand(null);
  renderSystem();
}

export function initLab({ api, toast, project, ensureRecognizer }) {
  state.api = api;
  state.toast = toast;
  state.project = project || (() => null);
  state.ensureRecognizer = ensureRecognizer;

  $("#lab-camera")?.addEventListener("click", () => (state.stream ? stopCamera() : startCamera()));
  $("#lab-speak")?.addEventListener("click", speakFocused);
  $("#lab-refresh")?.addEventListener("click", () => refresh());
  $("#lab-location")?.addEventListener("change", (event) => {
    localStorage.setItem("evolv:lab-location", event.target.value.trim().slice(0, 120));
    refresh();
  });
  const field = $("#lab-location");
  if (field) field.value = place();
  drawHand(null);
}

export async function refreshLab() {
  renderClock();
  renderCalendar();
  renderFocus();
  if (!state.clock) state.clock = setInterval(renderClock, 1000);
  if (!state.poll) state.poll = setInterval(refresh, 10 * 60 * 1000);
  await refresh();
}

// Leaving the display releases the camera. A webcam light that stays on after
// you navigate away is alarming, and it would be right to be alarmed.
export function suspendLab() {
  stopCamera();
  silence();
  if (state.clock) clearInterval(state.clock);
  if (state.poll) clearInterval(state.poll);
  state.clock = null;
  state.poll = null;
}
