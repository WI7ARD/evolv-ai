const $ = (selector) => document.querySelector(selector);

const state = { api: null, toast: null, getCsrf: null, runs: [], projects: [], providers: [], selectedId: "", streaming: false };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function activePlan(run) {
  return run?.plans?.find((plan) => plan.status === "active") || run?.plans?.at(-1) || null;
}

// A goal is now shared out between specialists, and the plan records which one
// each step went to. The step rows do not carry it — the whole plan is stored
// as JSON — so it is matched on the plan's own step id.
function assignedAgent(plan, step) {
  return plan?.definition?.steps?.find((item) => item.id === step.externalId)?.agent || "";
}

function agentLabel(id) {
  return String(id || "").replace(/(^|[-_])([a-z])/g, (match, separator, letter) => (separator ? " " : "") + letter.toUpperCase());
}

// The run of specialists, in order, with repeats collapsed: "Researcher →
// Analyst → Critic" says at a glance what shape the plan is. Not shown when
// only one is involved, because then it says nothing.
function handover(plan, run) {
  const names = (run?.steps || []).map((step) => assignedAgent(plan, step)).filter(Boolean);
  const sequence = names.filter((name, index) => name !== names[index - 1]);
  return new Set(sequence).size > 1 ? sequence.map(agentLabel).join(" → ") : "";
}

function statusLabel(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

function budgets(name) {
  if (name === "small") return { maxSteps: 5, maxRuntimeMs: 300000, maxToolCalls: 10, maxRetries: 1, maxTokens: 20000, maxCostUnits: 3 };
  if (name === "focused") return { maxSteps: 8, maxRuntimeMs: 600000, maxToolCalls: 16, maxRetries: 2, maxTokens: 40000, maxCostUnits: 6 };
  // The thorough preset stops rationing tool calls: a step may retry, and a
  // run that does real work should not stall on a budget rather than on the
  // work. Steps still bound how long a plan can be.
  return { maxSteps: 12, maxRuntimeMs: 1200000, maxToolCalls: 100, maxRetries: 2, maxTokens: 262144, maxCostUnits: 10 };
}

async function populateModels() {
  const provider = $("#agent-provider")?.value || "ollama";
  const select = $("#agent-model");
  if (!select) return;
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const payload = await state.api(`/api/providers/${encodeURIComponent(provider)}/models`);
    select.innerHTML = (payload.models || []).map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join("") || '<option value="">No models available</option>';
  } catch (error) {
    select.innerHTML = '<option value="">Provider unavailable</option>';
    state.toast(error.message, "error");
  }
}

function renderRunList() {
  const list = $("#agent-run-list");
  if (!list) return;
  $("#agent-run-count").textContent = String(state.runs.length);
  $("#agent-dot")?.classList.toggle("hidden", !state.runs.some((run) => run.state === "waiting_for_approval"));
  list.innerHTML = state.runs.length ? state.runs.map((run) => `
    <button class="agent-run-item ${run.id === state.selectedId ? "active" : ""}" type="button" data-agent-run="${escapeHtml(run.id)}">
      <strong>${escapeHtml(run.objective)}</strong><span class="status-pill ${run.state === "completed" ? "ready" : ""}">${escapeHtml(statusLabel(run.state))}</span>
      <small>${escapeHtml(run.goal?.status || "run")} · ${escapeHtml(run.providerId || "local")} / ${escapeHtml(run.modelId || "model")}</small>
    </button>`).join("") : '<p class="settings-note">No goal runs yet.</p>';
}

function approvalFrom(run) {
  const event = [...(run.events || [])].reverse().find((item) => item.type === "state.transition.requested" && item.payload?.to === "waiting_for_approval");
  return event?.payload?.toolRunId ? { toolRunId: event.payload.toolRunId, tool: event.payload.toolName || "proposed action" } : null;
}

function renderDetail() {
  const panel = $("#agent-run-detail");
  const run = state.runs.find((item) => item.id === state.selectedId);
  if (!panel || !run) { panel?.classList.add("hidden"); return; }
  // Which specialist a step was handed to. It lives in the plan rather than on
  // the step row, so it is matched on the id the plan wrote.
  panel.classList.remove("hidden");
  const plan = activePlan(run);
  const waiting = approvalFrom(run);
  const canEdit = ["planning", "waiting_for_approval", "paused"].includes(run.state) && !plan?.approvedAt;
  const canApprove = run.state === "waiting_for_approval" && !waiting;
  const canStart = run.state === "paused" && run.goal?.status === "approved";
  const canResume = run.state === "paused" && run.goal?.status !== "approved" && !run.steps.some((step) => step.state === "failed");
  const routeEvents = (run.events || []).filter((event) => ["routing.selected", "provider.fallback"].includes(event.type));
  panel.innerHTML = `
    <div class="agent-detail-head"><div><p class="eyebrow">GOAL ${escapeHtml(run.id.slice(0, 8))}</p><h2>${escapeHtml(run.objective)}</h2><p class="settings-note">Created ${escapeHtml(new Date(run.createdAt).toLocaleString())}</p></div><span class="status-pill ${run.state === "completed" ? "ready" : ""}">${escapeHtml(statusLabel(run.state))}</span></div>
    <div class="agent-route-card"><strong>${escapeHtml(run.providerId)} · ${escapeHtml(run.modelId)}</strong><br />${routeEvents.length ? routeEvents.map((event) => escapeHtml(event.type === "provider.fallback" ? `Fallback: ${event.payload.fromProvider}/${event.payload.fromModel} → ${event.payload.toProvider}/${event.payload.toModel}` : `${event.payload.phase}: ${event.payload.provider}/${event.payload.model}${event.payload.fallback ? " (fallback)" : ""}`)).join("<br />") : "Route is recorded when planning or execution begins."}</div>
    <h3>Success criteria</h3><ul class="agent-criteria">${(run.goal?.successCriteria || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    ${canEdit ? `<label><span class="field-label">REVIEW OR EDIT PLAN JSON</span><textarea id="agent-plan-editor" class="agent-plan-editor">${escapeHtml(JSON.stringify(plan?.definition || {}, null, 2))}</textarea></label><div class="agent-actions"><button class="secondary-button" data-agent-action="save-plan" type="button">Save revised plan</button><button class="primary-button" data-agent-action="approve-plan" type="button">Approve this plan</button></div>` : ""}
    ${canApprove ? '<div class="agent-actions"><button class="primary-button" data-agent-action="approve-plan" type="button">Approve this plan</button></div>' : ""}
    ${waiting ? `<div class="agent-route-card"><strong>Approval required · ${escapeHtml(waiting.tool)}</strong><br />The action has not executed. Review it before deciding.<div class="agent-actions"><button class="primary-button" data-agent-action="approve-effect" data-tool-run="${escapeHtml(waiting.toolRunId)}" type="button">Approve action</button><button class="secondary-button" data-agent-action="reject-effect" data-tool-run="${escapeHtml(waiting.toolRunId)}" type="button">Reject</button></div></div>` : ""}
    <h3>Plan · revision ${escapeHtml(plan?.revision || 1)}</h3>
    ${handover(plan, run) ? `<p class="agent-handover">${handover(plan, run)}</p>` : ""}
    <div class="agent-step-list">${(run.steps || []).map((step, index) => `
      <div class="agent-step ${escapeHtml(step.state)}"><span class="agent-step-index">${index + 1}</span><div><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.description)}</p><div class="agent-step-meta">${assignedAgent(plan, step) ? `<span class="status-pill agent">${escapeHtml(agentLabel(assignedAgent(plan, step)))}</span>` : ""}<span class="status-pill">${escapeHtml(step.kind)}</span><span class="status-pill">${escapeHtml(step.approvalPolicy || "safe")}</span><span class="status-pill">${escapeHtml(step.state)}</span>${step.attempts ? `<span class="status-pill">attempt ${step.attempts}</span>` : ""}</div>${step.error?.message ? `<p class="form-error">${escapeHtml(step.error.message)}</p>` : ""}</div>${step.state === "failed" ? `<button class="secondary-button" data-agent-action="retry" data-step-id="${escapeHtml(step.id)}" type="button">Retry</button>` : ""}</div>`).join("")}</div>
    <div class="agent-actions">
      ${canStart ? '<button class="primary-button" data-agent-action="start" type="button">Start approved plan</button>' : ""}
      ${canResume ? '<button class="primary-button" data-agent-action="resume" type="button">Resume</button>' : ""}
      ${!["paused", "completed", "failed", "cancelled", "waiting_for_approval"].includes(run.state) ? '<button class="secondary-button" data-agent-action="pause" type="button">Pause</button>' : ""}
      ${!["completed", "failed", "cancelled"].includes(run.state) ? '<button class="secondary-button" data-agent-action="replan" type="button">Request revised plan</button><button class="secondary-button" data-agent-action="cancel" type="button">Cancel</button>' : ""}
      <button class="secondary-button" data-agent-action="journal" type="button">Open journal</button>
      ${state.streaming ? '<span class="agent-stream-status">Running · live updates</span>' : ""}
    </div>
    <div class="agent-evidence"><h3>Evidence and artifacts</h3>${(run.evidence || []).length ? run.evidence.map((item) => `<details><summary>${escapeHtml(item.title)} · ${escapeHtml(item.kind)}</summary><pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre></details>`).join("") : '<p class="settings-note">Evidence appears here as steps finish.</p>'}</div>`;
}

async function refresh(selectId = "") {
  if (!state.api) return;
  const [runs, projects, providers, marketplace] = await Promise.all([
    state.api("/api/runs?limit=100"), state.api("/api/projects"), state.api("/api/providers"), state.api("/api/marketplace").catch(() => ({ installed: [] }))
  ]);
  state.runs = (runs.runs || []).filter((run) => run.executor === "goal-runner-v1");
  state.projects = projects.projects || [];
  state.providers = (providers.providers || []).filter((provider) => provider.id === "ollama" || provider.configured);
  if (selectId) state.selectedId = selectId;
  if (!state.selectedId && state.runs.length) state.selectedId = state.runs[0].id;
  $("#agent-project").innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  $("#agent-provider").innerHTML = state.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join("");
  const installed = marketplace.installed || marketplace.packs?.filter((pack) => pack.installed) || [];
  $("#agent-pack").innerHTML = '<option value="">No pack</option>' + installed.map((pack) => `<option value="${escapeHtml(pack.id)}">${escapeHtml(pack.name)}</option>`).join("");
  if (!$("#agent-model").options.length) await populateModels();
  renderRunList(); renderDetail();
}

async function stream(path) {
  state.streaming = true; renderDetail();
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-evolv-csrf": state.getCsrf() || "" }, body: "{}" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Run failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "error") state.toast(event.message, "error");
      if (event.run) {
        const index = state.runs.findIndex((item) => item.id === event.run.id);
        if (index >= 0) state.runs[index] = event.run;
        renderRunList(); renderDetail();
      }
    }
    if (done) break;
  }
  state.streaming = false;
  await refresh(state.selectedId);
}

async function action(button) {
  const run = state.runs.find((item) => item.id === state.selectedId);
  if (!run || state.streaming) return;
  const name = button.dataset.agentAction;
  try {
    if (name === "save-plan") {
      const plan = JSON.parse($("#agent-plan-editor").value);
      await state.api(`/api/runs/${run.id}/plan`, { method: "PATCH", body: JSON.stringify({ plan }) });
      state.toast("Revised plan saved. It still needs approval.");
    } else if (name === "approve-plan") {
      await state.api(`/api/runs/${run.id}/plan/approve`, { method: "POST", body: "{}" });
      state.toast("Plan approved. The managed run journal is authorized.");
    } else if (["start", "resume"].includes(name)) await stream(`/api/runs/${run.id}/${name === "start" ? "start" : "resume"}`);
    else if (name === "pause" || name === "cancel") await state.api(`/api/runs/${run.id}/${name}`, { method: "POST", body: "{}" });
    else if (name === "replan") {
      const reason = window.prompt("What should the revised plan address?", "Use the latest evidence and resolve the blocked step.");
      if (reason != null) await state.api(`/api/runs/${run.id}/replan`, { method: "POST", body: JSON.stringify({ reason }) });
    } else if (name === "retry") await stream(`/api/runs/${run.id}/steps/${button.dataset.stepId}/retry`);
    else if (name === "approve-effect" || name === "reject-effect") {
      await state.api(`/api/tool-runs/${button.dataset.toolRun}/decision`, { method: "POST", body: JSON.stringify({ decision: name === "approve-effect" ? "approved" : "rejected" }) });
      state.toast(name === "approve-effect" ? "Action approved and recorded." : "Action rejected. Nothing was changed.");
    } else if (name === "journal") {
      const result = await state.api(`/api/runs/${run.id}/artifacts`);
      if (!result.journal?.noteId) throw new Error(result.journal?.status === "conflict" ? "The journal changed in Obsidian and needs conflict review." : "No indexed Obsidian journal is available yet.");
      await state.api(`/api/obsidian/open`, { method: "POST", body: JSON.stringify({ noteId: result.journal.noteId }) });
    }
    await refresh(run.id);
  } catch (error) { state.streaming = false; state.toast(error.message, "error"); renderDetail(); }
}

export function initAgentWorkspace({ api, toast, getCsrf }) {
  state.api = api; state.toast = toast; state.getCsrf = getCsrf;
  $("#agent-provider")?.addEventListener("change", populateModels);
  $("#agent-refresh")?.addEventListener("click", () => refresh().catch((error) => toast(error.message, "error")));
  $("#agent-run-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-run]");
    if (!button) return;
    state.selectedId = button.dataset.agentRun; renderRunList(); renderDetail();
  });
  $("#agent-run-detail")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-agent-action]");
    if (button) action(button);
  });
  $("#agent-goal-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#agent-plan-button");
    button.disabled = true; button.textContent = "Planning…";
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const created = await api("/api/agent-goals", { method: "POST", body: JSON.stringify({
        objective: values.objective, successCriteria: values.successCriteria, projectId: values.projectId,
        packId: values.packId, provider: values.provider, model: values.model, budgets: budgets(values.budget)
      }) });
      state.selectedId = created.id;
      toast("Plan proposed. Review every step before approval.");
      await refresh(created.id);
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; button.textContent = "Propose plan"; }
  });
}

export { refresh as refreshAgentWorkspace };
