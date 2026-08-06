const $ = (selector) => document.querySelector(selector);

const state = { api: null, toast: null, sessions: [], selectedId: "", detail: null, busy: false };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

const OPEN_STATES = new Set(["open", "validating", "validated", "failed"]);

function stateLabel(value) {
  return String(value || "unknown").replace(/_/g, " ");
}

// The banner is the whole trust message: while a sandbox is open, the project
// on disk is untouched. It says so wherever a session is live.
function renderIndicator() {
  const live = state.sessions.filter((session) => OPEN_STATES.has(session.state)).length;
  const dot = $("#sandbox-dot");
  dot?.classList.toggle("hidden", live === 0);
  const banner = $("#sandbox-banner");
  if (!banner) return;
  banner.classList.toggle("hidden", live === 0);
  if (live) {
    banner.textContent = `Working in a copy — ${live} open sandbox${live === 1 ? "" : "es"}. Nothing has changed on disk.`;
  }
}

function renderList() {
  const list = $("#sandbox-list");
  if (!list) return;
  $("#sandbox-count").textContent = String(state.sessions.length);
  list.innerHTML = state.sessions.length ? state.sessions.map((session) => `
    <button class="agent-run-item ${session.id === state.selectedId ? "active" : ""}" type="button" data-sandbox="${escapeHtml(session.id)}">
      <strong>${escapeHtml(session.objective || "Untitled simulation")}</strong>
      <span class="status-pill ${session.state === "validated" ? "ready" : ""}">${escapeHtml(stateLabel(session.state))}</span>
      <small>${escapeHtml(String(session.fileCount))} file(s) mirrored · ${escapeHtml(new Date(session.createdAt).toLocaleString())}</small>
    </button>`).join("") : '<p class="settings-note">No simulations yet. Ask Evolv to try a change, or use /sandbox in chat.</p>';
}

function renderDetail() {
  const panel = $("#sandbox-detail");
  const session = state.detail;
  if (!panel) return;
  if (!session) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  const live = OPEN_STATES.has(session.state);
  const checks = session.validations || [];
  panel.innerHTML = `
    <div class="agent-detail-head">
      <div>
        <p class="eyebrow">SIMULATION ${escapeHtml(session.id.slice(0, 8))}</p>
        <h2>${escapeHtml(session.objective || "Untitled simulation")}</h2>
        <p class="settings-note">${escapeHtml(String(session.fileCount))} file(s) mirrored${session.truncated ? " (truncated at the index cap)" : ""} · opened ${escapeHtml(new Date(session.createdAt).toLocaleString())}</p>
      </div>
      <span class="status-pill ${session.state === "validated" ? "ready" : ""}">${escapeHtml(stateLabel(session.state))}</span>
    </div>
    ${live ? '<div class="agent-route-card"><strong>The project is untouched.</strong><br />These changes exist only inside the simulation. They reach the project only when you approve the promotion in chat.</div>' : ""}
    ${session.state === "promoted" ? '<div class="agent-route-card"><strong>Applied to the project.</strong><br />This simulation was approved and its files were written.</div>' : ""}
    <h3>Staged changes</h3>
    <div class="agent-step-list">${(session.edits || []).length ? session.edits.map((edit, index) => `
      <div class="agent-step"><span class="agent-step-index">${index + 1}</span><div>
        <h3>${escapeHtml(edit.relativePath)}</h3>
        <p>${escapeHtml(edit.summary || "No summary given.")}</p>
        <div class="agent-step-meta">
          <span class="status-pill">${escapeHtml(edit.operation)}</span>
          <span class="status-pill">${escapeHtml(String(edit.bytes))} bytes</span>
        </div>
      </div></div>`).join("") : '<p class="settings-note">Nothing has been staged in this simulation yet.</p>'}</div>
    <h3>Checks</h3>
    <div class="agent-evidence">${checks.length ? checks.map((check) => `
      <details><summary>${escapeHtml(check.kind)} · ${check.passed ? "passed" : "failed"}</summary><pre>${escapeHtml(check.output || check.summary || "No output.")}</pre></details>`).join("")
      : '<p class="settings-note">Not validated yet.</p>'}</div>
    <div class="agent-actions">
      ${live ? '<button class="secondary-button" data-sandbox-action="validate" type="button">Run checks</button>' : ""}
      ${live ? '<button class="secondary-button" data-sandbox-action="discard" type="button">Discard simulation</button>' : ""}
      ${session.state === "validated" ? '<span class="agent-stream-status">Checks passed — Evolv can now propose applying this in chat.</span>' : ""}
    </div>`;
}

async function select(sessionId) {
  state.selectedId = sessionId;
  renderList();
  try {
    state.detail = await state.api(`/api/sandboxes/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    state.detail = null;
    state.toast(error.message, "error");
  }
  renderDetail();
}

export async function refreshSandboxes(selectId = "") {
  if (!state.api) return;
  const payload = await state.api("/api/sandboxes?limit=50");
  state.sessions = payload.sessions || [];
  renderIndicator();
  const target = selectId || state.selectedId || state.sessions[0]?.id || "";
  renderList();
  if (target) await select(target); else { state.detail = null; renderDetail(); }
}

async function act(name) {
  if (!state.detail || state.busy) return;
  const id = state.detail.id;
  state.busy = true;
  try {
    if (name === "validate") {
      state.toast("Running checks inside the simulation…");
      state.detail = await state.api(`/api/sandboxes/${encodeURIComponent(id)}/validate`, {
        method: "POST", body: JSON.stringify({ scripts: [] })
      });
      state.toast(state.detail.state === "validated" ? "Checks passed." : "Checks failed — the project is unchanged.", state.detail.state === "validated" ? "" : "error");
    } else if (name === "discard") {
      await state.api(`/api/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.toast("Simulation discarded. The project was never touched.");
      state.selectedId = "";
    }
    await refreshSandboxes(name === "discard" ? "" : id);
  } catch (error) {
    state.toast(error.message, "error");
  } finally {
    state.busy = false;
  }
}

export function initSandboxWorkspace({ api, toast }) {
  state.api = api;
  state.toast = toast;
  $("#sandbox-refresh")?.addEventListener("click", () => refreshSandboxes().catch((error) => toast(error.message, "error")));
  $("#sandbox-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sandbox]");
    if (button) select(button.dataset.sandbox).catch((error) => toast(error.message, "error"));
  });
  $("#sandbox-detail")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sandbox-action]");
    if (button) act(button.dataset.sandboxAction);
  });
}
