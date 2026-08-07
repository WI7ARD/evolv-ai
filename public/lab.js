// The lab display: a glass-cockpit view of time, weather, and open work.
//
// Everything here is a read. The display shows what is already true and speaks
// it aloud on request; it never writes a task, never changes a setting, and
// asks for no device permissions at all.

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, project: null,
  clock: null, poll: null,
  data: { tasks: [], weather: null }
};

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

// The system panel is the "what am I" block: only things this display can
// actually verify. A panel that invented its contents would be the one thing
// here nobody could trust.
function renderSystem() {
  const host = $("#lab-system");
  if (!host) return;
  const tasks = (state.data.tasks || []).length;
  const lines = [
    `${tasks} open task${tasks === 1 ? "" : "s"}`,
    state.data.weather
      ? `Weather via ${escapeHtml(state.data.weather.attribution || "Open-Meteo")}`
      : "Weather idle",
    "Conversations and feedback stay in local SQLite",
    "This display uses no camera and no microphone"
  ];
  host.innerHTML = lines.map((line) => `<p>${line}</p>`).join("");
}

// What a panel would say if asked. Kept separate from the markup so the spoken
// version reads as a sentence rather than as scraped labels, and shown on
// screen for the time panel so its Speak button is never a surprise.
function spokenSummary(panel) {
  const now = new Date();
  if (panel === "time") {
    return `It is ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} on ${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}.`;
  }
  if (panel === "weather") {
    const weather = state.data.weather;
    if (!weather) return "No weather reading yet.";
    return `${weather.place}: ${Math.round(weather.temperature)} degrees and ${weather.conditions}, feels like ${Math.round(weather.feelsLike)}.`;
  }
  if (panel === "tasks") {
    const tasks = state.data.tasks || [];
    if (!tasks.length) return "Nothing is open.";
    return `${tasks.length} open task${tasks.length === 1 ? "" : "s"}. ${tasks.slice(0, 3).map((task) => task.title).join(". ")}.`;
  }
  return "Evolv is running locally. Conversations, feedback, and settings stay on this computer.";
}

function renderSummary() {
  const summary = $("#lab-summary");
  if (summary) summary.textContent = spokenSummary("time");
}

function speak(panel) {
  if (!("speechSynthesis" in window)) {
    state.toast("This system has no speech voices installed.", "error");
    return;
  }
  // Cancel first: without it a second press queues behind the first and the
  // display talks over itself for the next half minute.
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spokenSummary(panel));
  utterance.rate = 1;
  $("#lab-system-panel")?.classList.add("talking");
  utterance.onend = () => $("#lab-system-panel")?.classList.remove("talking");
  speechSynthesis.speak(utterance);
}

function silence() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
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
    renderSummary();
  } catch (error) {
    state.toast(error.message, "error");
  }
}

export function initLab({ api, toast, project }) {
  state.api = api;
  state.toast = toast;
  state.project = project || (() => null);

  // One delegated handler: a panel declares what it speaks, so adding a panel
  // needs no wiring here.
  $("#lab-view")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-speak]");
    if (button) speak(button.dataset.speak);
  });
  $("#lab-stop-speech")?.addEventListener("click", silence);
  $("#lab-refresh")?.addEventListener("click", () => refresh());
  $("#lab-location")?.addEventListener("change", (event) => {
    localStorage.setItem("evolv:lab-location", event.target.value.trim().slice(0, 120));
    refresh();
  });
  const field = $("#lab-location");
  if (field) field.value = place();
}

export async function refreshLab() {
  renderClock();
  renderCalendar();
  renderSummary();
  if (!state.clock) state.clock = setInterval(renderClock, 1000);
  if (!state.poll) state.poll = setInterval(refresh, 10 * 60 * 1000);
  await refresh();
}

// Leaving the display stops the clocks and any speech. Nothing should keep
// ticking, or talking, for a view nobody is looking at.
export function suspendLab() {
  silence();
  if (state.clock) clearInterval(state.clock);
  if (state.poll) clearInterval(state.poll);
  state.clock = null;
  state.poll = null;
}
