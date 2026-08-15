import { initAgentWorkspace, refreshAgentWorkspace } from "./agent-workspace.js";
import { initSandboxWorkspace, refreshSandboxes } from "./sandbox.js";
import { initPhysics, refreshPhysics, suspendPhysics } from "./physics.js";
import { initLab, refreshLab, suspendLab } from "./lab.js";
import { initDemo } from "./demo.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  provider: $("#provider-select"),
  projectSelect: $("#project-select"),
  model: $("#model-select"),
  think: $("#think-select"),
  mode: $("#mode-select"),
  messages: $("#messages"),
  welcome: $("#welcome"),
  composer: $("#composer"),
  prompt: $("#prompt"),
  send: $("#send-button"),
  stop: $("#stop-button"),
  healthDot: $("#status-dot"),
  healthLabel: $("#status-label"),
  healthDetail: $("#status-detail"),
  favoriteModel: $("#favorite-model"),
  commandMenu: $("#command-menu"),
  editBanner: $("#edit-banner"),
  editCancel: $("#edit-cancel"),
  saveChat: $("#save-chat-button"),
  localSetup: $("#local-setup"),
  localSetupTitle: $("#local-setup-title"),
  localSetupDetail: $("#local-setup-detail"),
  installButton: $("#install-evolv-local"),
  installProgress: $("#local-setup-progress"),
  installPhase: $("#local-setup-phase"),
  installBytes: $("#local-setup-bytes"),
  installBar: $("#local-setup-bar"),
  installStatus: $("#local-setup-status"),
  installCancel: $("#local-setup-cancel"),
  installHide: $("#local-setup-hide"),
  installError: $("#local-setup-error"),
  installErrorDetail: $("#local-setup-error-detail"),
  activeVersion: $("#active-version"),
  proposalDot: $("#proposal-dot"),
  intelligenceDot: $("#intelligence-dot"),
  proposalPanel: $("#proposal-panel"),
  noProposal: $("#no-proposal"),
  propose: $("#propose-button"),
  settings: $("#settings-dialog"),
  temperature: $("#temperature"),
  temperatureValue: $("#temperature-value"),
  contextSize: $("#context-size"),
  maxTokens: $("#max-tokens"),
  versionsList: $("#versions-list"),
  liveListenButton: $("#live-listen-button"),
  voiceListenStatus: $("#voice-listen-status"),
  desktopVoiceBadge: $("#desktop-voice-badge"),
  whisperStatus: $("#whisper-status"),
  piperStatus: $("#piper-status"),
  voiceDiagnosticsStatus: $("#voice-diagnostics-status"),
  chooseWhisperFolder: $("#choose-whisper-folder"),
  chooseWhisperModel: $("#choose-whisper-model"),
  downloadWhisperModels: $("#download-whisper-models"),
  choosePiperRuntime: $("#choose-piper-runtime"),
  choosePiperModel: $("#choose-piper-model"),
  downloadPiperModels: $("#download-piper-models"),
  voiceToggle: $("#voice-toggle"),
  voiceSelect: $("#voice-select"),
  voiceRate: $("#voice-rate"),
  voiceRateValue: $("#voice-rate-value"),
  hearingAccuracy: $("#hearing-accuracy"),
  hearingReviewMode: $("#hearing-review-mode"),
  hearingVocabulary: $("#hearing-vocabulary"),
  gestureButton: $("#gesture-button"),
  gestureDialog: $("#gesture-dialog"),
  gestureVideo: $("#gesture-video"),
  gestureCanvas: $("#gesture-canvas"),
  gestureLoading: $("#gesture-loading"),
  gestureName: $("#gesture-name"),
  gestureConfidence: $("#gesture-confidence"),
  cameraToggle: $("#camera-toggle"),
  modeDialog: $("#mode-dialog"),
  modeDialogTitle: $("#mode-dialog-title"),
  modeDialogDescription: $("#mode-dialog-description"),
  modeDialogBest: $("#mode-dialog-best"),
  modeDialogChanges: $("#mode-dialog-changes"),
  modeDialogTradeoff: $("#mode-dialog-tradeoff"),
  conversationList: $("#conversation-list"),
  conversationSearch: $("#conversation-search"),
  conversationFilter: $("#conversation-filter"),
  toolsMaster: $("#tools-master"),
  toolsList: $("#tools-list"),
  toolRunsList: $("#tool-runs-list"),
  attachButton: $("#attach-button"),
  attachInput: $("#attach-input"),
  attachmentStrip: $("#attachment-strip"),
  backupButton: $("#backup-button"),
  exportButton: $("#export-button"),
  importButton: $("#import-button"),
  importInput: $("#import-input"),
  importPreview: $("#import-preview"),
  importSummary: $("#import-summary"),
  importConfirm: $("#import-confirm"),
  importCancel: $("#import-cancel"),
  passwordDialog: $("#password-dialog"),
  passwordForm: $("#change-password-form"),
  passwordError: $("#password-error"),
  providerSettingsList: $("#provider-settings-list"),
  accountName: $("#account-name"),
  desktopUpdateTitle: $("#desktop-update-title"),
  desktopUpdateVersion: $("#desktop-update-version"),
  desktopUpdateStatus: $("#desktop-update-status"),
  desktopUpdateNotes: $("#desktop-update-notes"),
  desktopUpdateCheck: $("#desktop-update-check"),
  desktopUpdateInstall: $("#desktop-update-install")
};

const defaultSettings = {
  provider: "ollama",
  model: "",
  think: "medium",
  temperature: 0.7,
  numCtx: 8192,
  maxTokens: 4096,
  autoSpeak: false,
  voiceURI: "",
  voiceRate: 1,
  hearingAccuracy: "enhanced",
  hearingReviewMode: "uncertain",
  hearingVocabulary: "",
  mode: "standard"
};

const modeDefinitions = {
  standard: {
    name: "Collaborate",
    description: "The balanced default. Evolv answers directly using the conversation and any relevant approved knowledge.",
    best: "Everyday chat, drafting, explanation, summarization, and quick decisions.",
    changes: "Uses your normal temperature setting and a straightforward assistant response strategy.",
    tradeoff: "Fastest and least opinionated, but it does not explicitly run the deliberate cognitive cycle."
  },
  cognitive: {
    name: "Cognitive",
    description: "A deliberate problem-solving architecture that identifies the goal, retrieves relevant knowledge, considers approaches, checks constraints, and then responds.",
    best: "Planning, technical problems, difficult decisions, analysis, and work where consistency matters.",
    changes: "Adds a private perceive–retrieve–plan–verify cycle. It returns conclusions, not hidden chain-of-thought.",
    tradeoff: "May respond more slowly and conservatively. This simulates a disciplined workflow; it is not human consciousness."
  },
  creative: {
    name: "Muse",
    description: "An exploratory mode designed to produce original connections, concepts, stories, and alternative possibilities.",
    best: "Brainstorming, art direction, naming, fiction, invention, and escaping obvious solutions.",
    changes: "Raises generation variation, uses a randomized seed, and explicitly searches for non-obvious connections.",
    tradeoff: "More surprising means less predictable. Verify factual claims and feasibility before relying on them."
  }
};

const app = {
  state: null,
  models: [],
  providers: [],
  intelligence: null,
  evolution: null,
  intelligenceModels: [],
  obsidian: null,
  toolRecipes: [],
  marketplace: null,
  projects: [],
  activeProjectId: localStorage.getItem("evolv:active-project") || "",
  marketplaceTab: "discover",
  marketplaceSelectedId: "",
  pendingMarketplaceInstall: null,
  marketplaceInstallInFlight: false,
  marketplaceConfigSaveInFlight: false,
  pendingPackCommand: null,
  activePack: null,
  account: null,
  legacyConversations: loadJson("evolv:conversations", []),
  legacyCurrent: loadJson("evolv:current", []),
  conversations: [],
  conversationId: localStorage.getItem("evolv:active-conversation") || "",
  messages: [],
  tools: [],
  controller: null,
  generating: false,
  attachments: [],
  pendingImport: null,
  auth: null,
  idleTimer: null,
  lastActivityAt: Date.now(),
  settings: {
    ...defaultSettings,
    ...loadJson("evolv:settings", {}),
    ...loadJson("evolv:device-settings", {})
  },
  gestureRecognizer: null,
  drawingUtils: null,
  cameraStream: null,
  gestureFrame: null,
  gestureCandidate: null,
  lastGestureAction: 0,
  lastGestureFrame: 0,
  pendingMode: null,
  pendingModeAction: null,
  desktopVoice: {
    status: null,
    speaking: false,
    audio: null,
    audioUrl: "",
    holding: false,
    recording: false,
    transcribing: false,
    mediaStream: null,
    audioContext: null,
    source: null,
    processor: null,
    silentGain: null,
    chunks: [],
    sampleRate: 48_000,
    maxTimer: null,
    lastTranscript: "",
    lastHearing: null,
    lastError: ""
  }
};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveLocal() {
  localStorage.setItem("evolv:active-conversation", app.conversationId || "");
  localStorage.setItem("evolv:device-settings", JSON.stringify({
    autoSpeak: app.settings.autoSpeak,
    voiceURI: app.settings.voiceURI,
    voiceRate: app.settings.voiceRate,
    hearingAccuracy: app.settings.hearingAccuracy,
    hearingReviewMode: app.settings.hearingReviewMode,
    hearingVocabulary: app.settings.hearingVocabulary
  }));
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && app.auth?.csrfToken) {
    headers["x-evolv-csrf"] = app.auth.csrfToken;
  }
  const response = await fetch(path, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  // Only the local session's AUTH_REQUIRED response should lock Evolv.
  // Provider authentication failures must stay inside the provider UI.
  if (response.status === 401 && payload.code === "AUTH_REQUIRED" && path !== "/api/auth/login") {
    window.location.replace("/login.html");
    throw new Error("Evolv is locked.");
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.code = payload.code || "REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function initializeAuth() {
  const response = await fetch("/api/auth/status", { cache: "no-store" });
  const status = await response.json().catch(() => ({}));
  if (!response.ok || !status.authenticated) {
    window.location.replace("/login.html");
    return false;
  }
  app.auth = status;
  return true;
}

async function lockEvolv() {
  stopSpeech();
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {}
  window.location.replace("/login.html");
}

function armIdleLock() {
  app.lastActivityAt = Date.now();
  clearTimeout(app.idleTimer);
  const timeout = Math.max(60_000, Number(app.auth?.idleTimeoutMs) || 30 * 60 * 1000);
  app.idleTimer = setTimeout(lockEvolv, timeout);
}

function startSessionWatch() {
  for (const eventName of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(eventName, armIdleLock, { passive: true });
  }
  armIdleLock();
  setInterval(async () => {
    if (document.hidden || Date.now() - app.lastActivityAt > 5 * 60 * 1000) return;
    try {
      const status = await api("/api/auth/status");
      if (status.csrfToken) app.auth.csrfToken = status.csrfToken;
    } catch {}
  }, 5 * 60 * 1000);
}

async function migrationFingerprint(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function migrateBrowserData() {
  const status = await api("/api/migrations/status");
  if (status.browserImported) return;
  const payload = {
    conversations: app.legacyConversations,
    current: app.legacyCurrent,
    settings: loadJson("evolv:settings", {})
  };
  payload.fingerprint = await migrationFingerprint(payload);
  const result = await api("/api/migrations/browser-v1", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  localStorage.setItem("evolv:sqlite-migrated-v1", JSON.stringify(result));
}

async function loadServerSettings() {
  const settings = await api("/api/settings");
  app.settings = {
    ...app.settings,
    ...Object.fromEntries(Object.entries(settings).filter(([key]) =>
      ["provider", "model", "think", "temperature", "numCtx", "maxTokens", "mode", "intelligence"].includes(key)
    ))
  };
}

function persistAiSettings() {
  api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      model: app.settings.model,
      provider: app.settings.provider,
      think: app.settings.think,
      temperature: app.settings.temperature,
      numCtx: app.settings.numCtx,
      maxTokens: app.settings.maxTokens,
      mode: app.settings.mode
    })
  }).catch((error) => toast(`Settings: ${error.message}`, "error"));
  saveLocal();
}

function conversationMessages(rows) {
  const output = [];
  for (const row of rows || []) {
    if (row.role === "tool") {
      const assistant = [...output].reverse().find((message) => message.role === "assistant");
      if (assistant) {
        assistant.tools ||= [];
        const existing = assistant.tools.find((tool) => tool.callId === row.toolCallId);
        const activity = {
          callId: row.toolCallId,
          name: row.toolName,
          status: row.metadata?.cached ? "cached"
            : row.status === "pending-approval" ? "approval_required"
              : row.status === "complete" ? "completed" : "failed",
          output: row.content,
          durationMs: row.metadata?.durationMs || 0,
          runId: row.metadata?.runId || null,
          pendingApproval: Boolean(row.metadata?.pendingApproval)
        };
        if (existing) Object.assign(existing, activity);
        else assistant.tools.push(activity);
      }
      continue;
    }
    if (!["user", "assistant"].includes(row.role)) continue;
    output.push({
      id: row.id,
      role: row.role,
      content: row.content,
      thinking: row.thinking || "",
      model: row.model,
      mode: row.mode,
      status: row.status,
      provider: row.metadata?.provider || "",
      agentRunId: row.metadata?.agentRunId || "",
      routing: row.metadata?.routing || null,
      knowledge: row.metadata?.knowledge || [],
      memory: row.metadata?.memory || [],
      vault: row.metadata?.vault || null,
      project: row.metadata?.project || null,
      packSession: row.metadata?.packSession || null,
      ...(row.role === "user" && row.metadata?.images?.length ? { images: row.metadata.images } : {}),
      tools: (row.metadata?.tool_calls || []).map((call) => ({
        callId: call.id,
        name: call.function?.name || "tool",
        arguments: call.function?.arguments || {},
        status: "requested"
      }))
    });
  }
  return output;
}

async function refreshConversations({ openCurrent = false } = {}) {
  const query = encodeURIComponent(elements.conversationSearch?.value || "");
  const status = elements.conversationFilter?.value || "active";
  const payload = await api(`/api/conversations?status=${status}&query=${query}&limit=100`);
  app.conversations = payload.conversations;
  renderConversationList();
  if (openCurrent) {
    const exists = app.conversations.some((conversation) => conversation.id === app.conversationId);
    if (exists) await openConversation(app.conversationId);
    else if (status === "active") await startNewChat();
  }
}

async function openConversation(id) {
  const [conversation, runPayload] = await Promise.all([
    api(`/api/conversations/${encodeURIComponent(id)}`),
    api(`/api/runs?conversationId=${encodeURIComponent(id)}&limit=50`).catch(() => ({ runs: [] }))
  ]);
  app.conversationId = conversation.id;
  app.messages = conversationMessages(conversation.messages);
  for (const run of runPayload.runs || []) {
    const message = [...app.messages].reverse().find((item) => item.role === "assistant" && item.agentRunId === run.id);
    if (message) message.agentRun = { id: run.id, state: run.state, budgets: run.budgets, stepId: run.steps?.find((step) => step.state === "running" || step.state === "pending")?.id || null };
  }
  const lastUser = [...app.messages].reverse().find((message) => message.role === "user");
  const conversationProject = [...app.messages].reverse().find((message) => message.project?.id)?.project;
  if (conversationProject && app.projects.some((project) => project.id === conversationProject.id)) {
    app.activeProjectId = conversationProject.id;
    localStorage.setItem("evolv:active-project", app.activeProjectId);
    renderProjects();
  }
  app.activePack = lastUser?.packSession || null;
  renderActivePack();
  saveLocal();
  renderMessages();
  renderConversationList();
  switchView("chat");
}

function renderConversationList() {
  if (!elements.conversationList) return;
  const status = elements.conversationFilter.value;
  elements.conversationList.innerHTML = app.conversations.length ? app.conversations.map((conversation) => `
    <div class="conversation-item ${conversation.id === app.conversationId ? "active" : ""}" data-conversation-id="${escapeHtml(conversation.id)}">
      <strong>${escapeHtml(conversation.title)}</strong>
      <div class="conversation-actions">
        ${status === "trash"
          ? `<button data-action="restore" title="Restore">↶</button><button data-action="permanent" title="Delete permanently">×</button>`
          : `<button data-action="rename" title="Rename">✎</button><button data-action="archive" title="Archive">⌁</button><button data-action="trash" title="Move to trash">×</button>`}
      </div>
      <small>${escapeHtml(conversation.preview || `${conversation.messageCount || 0} messages`)}</small>
    </div>
  `).join("") : '<small class="conversation-empty">No conversations here.</small>';
  $$(".conversation-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (!event.target.closest("button")) openConversation(item.dataset.conversationId).catch((error) => toast(error.message, "error"));
    });
  });
  $$(".conversation-actions button").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const item = button.closest(".conversation-item");
    const id = item.dataset.conversationId;
    const action = button.dataset.action;
    try {
      if (action === "rename") {
        const current = app.conversations.find((conversation) => conversation.id === id);
        const title = window.prompt("Conversation title", current?.title || "");
        if (title?.trim()) await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
      } else if (action === "archive") {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
      } else if (action === "trash") {
        await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      } else if (action === "restore") {
        await api(`/api/conversations/${encodeURIComponent(id)}/restore`, { method: "POST" });
      } else if (action === "permanent" && window.confirm("Permanently delete this conversation? This cannot be undone.")) {
        await api(`/api/conversations/${encodeURIComponent(id)}?permanent=true`, { method: "DELETE" });
      }
      await refreshConversations({ openCurrent: action === "trash" && id === app.conversationId });
    } catch (error) {
      toast(error.message, "error");
    }
  }));
}

function toast(message, type = "") {
  const region = $("#toast-region");
  const key = `${type}:${String(message)}`;
  // Background refreshes can observe the same provider failure together.
  // Deduplicate them and keep errors from covering the screen.
  if ([...region.children].some((item) => item.dataset.toastKey === key)) return;
  while (region.childElementCount >= 3) region.firstElementChild?.remove();
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  node.dataset.toastKey = key;
  region.append(node);
  setTimeout(() => node.remove(), 3500);
}

function explainMode(mode, afterConfirm = null) {
  const definition = modeDefinitions[mode];
  if (!definition) return;
  app.pendingMode = mode;
  app.pendingModeAction = afterConfirm;
  elements.modeDialogTitle.textContent = definition.name;
  elements.modeDialogDescription.textContent = definition.description;
  elements.modeDialogBest.textContent = definition.best;
  elements.modeDialogChanges.textContent = definition.changes;
  elements.modeDialogTradeoff.textContent = definition.tradeoff;
  $("#mode-confirm").textContent = mode === app.settings.mode ? `Keep ${definition.name}` : `Use ${definition.name}`;
  elements.modeDialog.showModal();
}

function closeModeDialog() {
  app.pendingMode = null;
  app.pendingModeAction = null;
  elements.mode.value = app.settings.mode;
  elements.modeDialog.close();
}

function confirmMode() {
  const mode = app.pendingMode;
  if (!mode) return closeModeDialog();
  const action = app.pendingModeAction;
  app.settings.mode = mode;
  elements.mode.value = mode;
  persistAiSettings();
  elements.modeDialog.close();
  app.pendingMode = null;
  app.pendingModeAction = null;
  toast(`Mind mode: ${modeDefinitions[mode].name}`);
  action?.();
}

function plainText(value = "") {
  return value
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function populateVoices() {
  if (!("speechSynthesis" in window)) {
    elements.voiceToggle.disabled = true;
    elements.voiceSelect.innerHTML = '<option value="">Speech unavailable</option>';
    return;
  }
  const voices = speechSynthesis.getVoices();
  if (!voices.length) {
    speechSynthesis.onvoiceschanged = populateVoices;
    return;
  }
  elements.voiceSelect.innerHTML = '<option value="">System default</option>';
  for (const voice of voices) {
    elements.voiceSelect.add(new Option(`${voice.name} · ${voice.lang}`, voice.voiceURI));
  }
  if (voices.some((voice) => voice.voiceURI === app.settings.voiceURI)) {
    elements.voiceSelect.value = app.settings.voiceURI;
  }
}

function setSpeakingState(speaking) {
  const active = Boolean(speaking);
  app.desktopVoice.speaking = active;
  document.documentElement.classList.toggle("tts-speaking", active);
  document.documentElement.dataset.ttsState = active ? "speaking" : "idle";
  $$(".speak-button").forEach((button) => button.classList.toggle("speaking", active));
}

function stopSpeech() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (app.desktopVoice.audio) {
    app.desktopVoice.audio.pause();
    app.desktopVoice.audio = null;
  }
  if (app.desktopVoice.audioUrl) {
    URL.revokeObjectURL(app.desktopVoice.audioUrl);
    app.desktopVoice.audioUrl = "";
  }
  window.evolvDesktopVoice?.stopSpeaking().catch(() => {});
  setSpeakingState(false);
}

function speakWithSystemVoice(content) {
  if (!("speechSynthesis" in window)) {
    toast("No text-to-speech engine is available.", "error");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(content);
  const voice = speechSynthesis.getVoices().find((item) => item.voiceURI === app.settings.voiceURI);
  if (voice) utterance.voice = voice;
  utterance.rate = Number(app.settings.voiceRate) || 1;
  utterance.onstart = () => setSpeakingState(true);
  utterance.onend = () => setSpeakingState(false);
  utterance.onerror = () => setSpeakingState(false);
  speechSynthesis.speak(utterance);
}

function base64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function speakText(text) {
  const content = plainText(text);
  if (!content) return;
  stopSpeech();
  if (window.evolvDesktopVoice && app.desktopVoice.status?.piper?.ready) {
    try {
      const result = await window.evolvDesktopVoice.synthesize(content, { rate: Number(app.settings.voiceRate) || 1 });
      const blob = new Blob([base64Bytes(result.audioBase64)], { type: result.format || "audio/wav" });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      app.desktopVoice.audio = audio;
      app.desktopVoice.audioUrl = audioUrl;
      audio.onplaying = () => setSpeakingState(true);
      audio.onpause = () => setSpeakingState(false);
      audio.onended = () => stopSpeech();
      audio.onerror = () => {
        stopSpeech();
        toast("Piper audio could not be played; using the device voice.", "error");
        speakWithSystemVoice(content);
      };
      await audio.play();
      return;
    } catch (error) {
      stopSpeech();
      toast(`Piper unavailable: ${error.message}. Using the device voice.`, "error");
    }
  }
  speakWithSystemVoice(content);
}

function setListenStatus(text = "") {
  elements.voiceListenStatus.textContent = text;
  elements.voiceListenStatus.classList.toggle("hidden", !text);
  $("#composer-hint").classList.toggle("hidden", Boolean(text));
}

function stopMicrophoneCapture() {
  const voice = app.desktopVoice;
  clearTimeout(voice.maxTimer);
  voice.maxTimer = null;
  voice.recording = false;
  voice.processor?.disconnect();
  voice.source?.disconnect();
  voice.silentGain?.disconnect();
  for (const track of voice.mediaStream?.getTracks?.() || []) track.stop();
  voice.mediaStream = null;
  voice.processor = null;
  voice.source = null;
  voice.silentGain = null;
  elements.liveListenButton.classList.remove("recording");
}

function encodePushToTalkWav(chunks, inputRate) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const input = new Float32Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    input.set(chunk, cursor);
    cursor += chunk.length;
  }
  const outputRate = 16_000;
  const ratio = Math.max(1, inputRate / outputRate);
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) sum += input[sourceIndex];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const wav = new ArrayBuffer(44 + output.byteLength);
  const view = new DataView(wav);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + output.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true);
  view.setUint32(28, outputRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, output.byteLength, true);
  new Int16Array(wav, 44).set(output);
  return wav;
}

function hearingOptions() {
  const vocabulary = String(app.settings.hearingVocabulary || "")
    .split(/[,;\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const contextPhrases = [...app.messages].reverse()
    .filter((message) => message.role === "user" && message.content)
    .slice(0, 3).reverse()
    .map((message) => String(message.content).replace(/\s+/g, " ").slice(0, 140));
  return { vocabulary, contextPhrases, multiPass: app.settings.hearingAccuracy !== "fast" };
}

async function startPushToTalk() {
  const voice = app.desktopVoice;
  if (voice.holding || voice.recording || voice.transcribing) return;
  if (!window.evolvDesktopVoice?.transcribe || !navigator.mediaDevices?.getUserMedia) {
    return toast("Push-to-talk is available in the Evolv desktop app.", "error");
  }
  if (app.generating) return toast("Wait for the current answer to finish before using push-to-talk.");
  voice.holding = true;
  voice.lastError = "";
  elements.liveListenButton.classList.add("recording");
  setListenStatus("Opening microphone… keep holding");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    if (!voice.holding) {
      for (const track of stream.getTracks()) track.stop();
      setListenStatus("");
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    voice.mediaStream = stream;
    voice.audioContext = context;
    voice.source = source;
    voice.processor = processor;
    voice.silentGain = silentGain;
    voice.sampleRate = context.sampleRate;
    voice.chunks = [];
    voice.recording = true;
    processor.onaudioprocess = (event) => {
      if (voice.recording) voice.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    setListenStatus("Listening while held · release to send");
    voice.maxTimer = setTimeout(() => {
      voice.holding = false;
      stopPushToTalk().catch(() => {});
      toast("Push-to-talk stops after 30 seconds.");
    }, 30_000);
  } catch (error) {
    voice.holding = false;
    stopMicrophoneCapture();
    voice.lastError = error.message;
    setListenStatus("");
    const denied = error.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in Windows and reopen Evolv." : error.message;
    toast(`Push-to-talk: ${denied}`, "error");
    renderDesktopVoiceStatus();
  }
}

async function stopPushToTalk() {
  const voice = app.desktopVoice;
  voice.holding = false;
  if (!voice.recording) {
    elements.liveListenButton.classList.remove("recording");
    return;
  }
  const chunks = voice.chunks;
  const sampleRate = voice.sampleRate;
  const context = voice.audioContext;
  voice.audioContext = null;
  stopMicrophoneCapture();
  await context?.close().catch(() => {});
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  voice.chunks = [];
  if (samples < sampleRate * 0.18) {
    setListenStatus("");
    return toast("Hold the microphone button a little longer while speaking.");
  }
  voice.transcribing = true;
  elements.liveListenButton.classList.add("active");
  setListenStatus("Microphone off · transcribing locally…");
  renderDesktopVoiceStatus();
  try {
    const wav = encodePushToTalkWav(chunks, sampleRate);
    const result = await window.evolvDesktopVoice.transcribe(new Uint8Array(wav), hearingOptions());
    const transcript = String(result?.text || "").trim();
    voice.lastTranscript = transcript;
    voice.lastHearing = result;
    if (!transcript) {
      setListenStatus("");
      return toast("Whisper did not detect speech. Hold the button closer to the microphone and try again.");
    }
    elements.prompt.value = transcript;
    resizePrompt();
    const confidence = Number.isFinite(result?.confidence) ? Math.round(result.confidence * 100) : null;
    const mustReview = app.settings.hearingReviewMode === "always" || result?.needsReview;
    if (mustReview) {
      const alternative = result?.alternatives?.[0] ? ` Alternative: “${String(result.alternatives[0]).slice(0, 80)}”` : "";
      setListenStatus(`${result?.needsReview ? "Uncertain" : "Review"}${confidence != null ? ` · ${confidence}%` : ""}: ${transcript.slice(0, 80)}`);
      elements.prompt.focus();
      toast(`Transcription is in the message box for review.${alternative}`, result?.needsReview ? "error" : undefined);
      return;
    }
    setListenStatus(`Heard clearly${confidence != null ? ` · ${confidence}%` : ""}: ${transcript.slice(0, 80)}`);
    await sendMessage(transcript);
  } catch (error) {
    voice.lastError = error.message;
    setListenStatus("");
    toast(`Local transcription: ${error.message}`, "error");
  } finally {
    voice.transcribing = false;
    elements.liveListenButton.classList.remove("active");
    renderDesktopVoiceStatus();
  }
}

function renderDesktopVoiceStatus() {
  const supported = Boolean(window.evolvDesktopVoice?.transcribe);
  const status = app.desktopVoice.status;
  const recognition = status?.recognition;
  elements.liveListenButton.disabled = !supported || !recognition?.ready || app.desktopVoice.transcribing;
  elements.chooseWhisperFolder.disabled = !supported;
  elements.chooseWhisperModel.disabled = !supported;
  elements.downloadWhisperModels.disabled = !supported;
  elements.hearingAccuracy.disabled = !supported;
  elements.hearingReviewMode.disabled = !supported;
  elements.hearingVocabulary.disabled = !supported;
  elements.liveListenButton.classList.toggle("recording", app.desktopVoice.recording);
  elements.desktopVoiceBadge.textContent = app.desktopVoice.recording
    ? "Recording" : app.desktopVoice.transcribing ? "Transcribing" : recognition?.ready ? "Push-to-talk ready" : supported ? "Checking…" : "Desktop only";
  elements.desktopVoiceBadge.classList.toggle("ready", Boolean(supported && recognition?.ready));
  elements.whisperStatus.textContent = recognition?.ready
    ? `Push-to-talk ready · ${recognition.engine} · ${recognition.model} · ${recognition.modelTier || "unknown"} accuracy tier`
    : supported ? `Whisper needs: ${(recognition?.missing || []).join(", ") || "checking local engine"}` : "Open the Evolv desktop app to use local push-to-talk.";
  const piper = status?.piper;
  elements.piperStatus.textContent = piper?.ready
    ? `Piper ready · ${piper.model}`
    : supported ? `Piper still needs: ${(piper?.missing || []).join(", ") || "checking local files"}.` : "Piper is available in the Evolv desktop app.";
  const hearing = app.desktopVoice.lastHearing;
  const audio = hearing?.audio || status?.diagnostics?.lastAudio;
  elements.voiceDiagnosticsStatus.textContent = [
    `Mode: push-to-talk (microphone active only while held)`,
    `State: ${app.desktopVoice.recording ? "recording" : app.desktopVoice.transcribing ? "transcribing" : "idle"}`,
    `Last heard: ${app.desktopVoice.lastTranscript || status?.diagnostics?.lastTranscript || "nothing transcribed yet"}`,
    hearing ? `Estimated confidence: ${Math.round((hearing.confidence || 0) * 100)}% (${hearing.confidenceSource || "local evidence"})` : "",
    hearing ? `Decoder agreement: ${Math.round((hearing.agreement || 0) * 100)}% · ${hearing.hearing?.passes || 1} pass${hearing.hearing?.passes === 1 ? "" : "es"}` : "",
    audio ? `Audio: ${audio.quality} · ${audio.processedDurationMs} ms · SNR ~${audio.snrDb} dB · gain ${audio.gain}×${audio.issues?.length ? ` · ${audio.issues.join(", ")}` : ""}` : "",
    hearing?.alternatives?.length ? `Alternative heard: ${hearing.alternatives.join(" | ").slice(0, 300)}` : "",
    hearing?.needsReview ? "Decision: held for human review; nothing was sent." : "",
    app.desktopVoice.lastError ? `Last error: ${app.desktopVoice.lastError}` : ""
  ].filter(Boolean).join("\n");
}

async function refreshDesktopVoiceStatus() {
  if (window.evolvDesktopVoice) {
    try { app.desktopVoice.status = await window.evolvDesktopVoice.status(); }
    catch (error) { app.desktopVoice.lastError = error.message; }
  }
  renderDesktopVoiceStatus();
}

async function initializeDesktopVoice() {
  await refreshDesktopVoiceStatus();
}

function speakLatestReply() {
  const latest = [...app.messages].reverse().find((message) => message.role === "assistant" && message.content);
  if (!latest) {
    toast("There is no assistant reply to read yet.");
    return;
  }
  speakText(latest.content);
}

async function ensureGestureRecognizer() {
  if (app.gestureRecognizer) return;
  elements.gestureLoading.textContent = "Loading local gesture model…";
  const {
    FilesetResolver,
    GestureRecognizer,
    DrawingUtils
  } = await import("/vendor/mediapipe/vision_bundle.mjs");
  const vision = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
  const options = {
    baseOptions: {
      modelAssetPath: "/models/gesture_recognizer.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
    cannedGesturesClassifierOptions: { scoreThreshold: 0.65 }
  };
  try {
    app.gestureRecognizer = await GestureRecognizer.createFromOptions(vision, options);
  } catch {
    options.baseOptions.delegate = "CPU";
    app.gestureRecognizer = await GestureRecognizer.createFromOptions(vision, options);
  }
  app.gestureConnections = GestureRecognizer.HAND_CONNECTIONS;
  app.drawingUtils = new DrawingUtils(elements.gestureCanvas.getContext("2d"));
}

async function startCamera() {
  if (app.cameraStream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera access is not supported by this browser.", "error");
    return;
  }
  elements.cameraToggle.disabled = true;
  try {
    await ensureGestureRecognizer();
    elements.gestureLoading.textContent = "Waiting for camera permission…";
    app.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 } },
      audio: false
    });
    elements.gestureVideo.srcObject = app.cameraStream;
    await elements.gestureVideo.play();
    elements.gestureCanvas.width = elements.gestureVideo.videoWidth || 960;
    elements.gestureCanvas.height = elements.gestureVideo.videoHeight || 540;
    elements.gestureLoading.classList.add("hidden");
    elements.cameraToggle.textContent = "Stop camera";
    elements.gestureButton.classList.add("active");
    app.lastGestureFrame = 0;
    gestureLoop();
  } catch (error) {
    stopCamera();
    toast(`Camera: ${error.message}`, "error");
    elements.gestureLoading.textContent = "Camera could not start";
    elements.gestureLoading.classList.remove("hidden");
  } finally {
    elements.cameraToggle.disabled = false;
  }
}

function stopCamera() {
  if (app.gestureFrame) cancelAnimationFrame(app.gestureFrame);
  app.gestureFrame = null;
  app.cameraStream?.getTracks().forEach((track) => track.stop());
  app.cameraStream = null;
  elements.gestureVideo.srcObject = null;
  const context = elements.gestureCanvas.getContext("2d");
  context.clearRect(0, 0, elements.gestureCanvas.width, elements.gestureCanvas.height);
  elements.gestureLoading.textContent = "Camera is off";
  elements.gestureLoading.classList.remove("hidden");
  elements.gestureName.textContent = "No gesture";
  elements.gestureConfidence.textContent = "—";
  elements.cameraToggle.textContent = "Start camera";
  elements.gestureButton.classList.remove("active");
  app.gestureCandidate = null;
}

function gestureLoop(now = performance.now()) {
  if (!app.cameraStream) return;
  if (now - app.lastGestureFrame >= 80 && elements.gestureVideo.readyState >= 2) {
    app.lastGestureFrame = now;
    try {
      const result = app.gestureRecognizer.recognizeForVideo(elements.gestureVideo, now);
      renderGestureResult(result, now);
    } catch (error) {
      console.warn("Gesture frame skipped:", error);
    }
  }
  app.gestureFrame = requestAnimationFrame(gestureLoop);
}

function renderGestureResult(result, now) {
  const context = elements.gestureCanvas.getContext("2d");
  context.clearRect(0, 0, elements.gestureCanvas.width, elements.gestureCanvas.height);
  for (const landmarks of result.landmarks || []) {
    app.drawingUtils.drawConnectors(landmarks, app.gestureConnections, { color: "#bdff47", lineWidth: 2 });
    app.drawingUtils.drawLandmarks(landmarks, { color: "#f1f3ef", lineWidth: 1, radius: 2 });
  }

  const category = result.gestures?.[0]?.[0];
  const name = category?.categoryName || "None";
  const score = category?.score || 0;
  if (name === "Open_Palm") {
    elements.gestureName.textContent = "No gesture";
    elements.gestureConfidence.textContent = "—";
    app.gestureCandidate = null;
    return;
  }
  elements.gestureName.textContent = name === "None" ? "No gesture" : name.replaceAll("_", " ");
  elements.gestureConfidence.textContent = score ? `${Math.round(score * 100)}%` : "—";

  if (name === "None" || score < 0.7) {
    app.gestureCandidate = null;
    return;
  }
  if (app.gestureCandidate?.name !== name) {
    app.gestureCandidate = { name, since: now };
    return;
  }
  if (now - app.gestureCandidate.since > 900 && now - app.lastGestureAction > 2400) {
    app.lastGestureAction = now;
    app.gestureCandidate = { name, since: now };
    executeGesture(name);
  }
}

function closeGesturePanel() {
  stopCamera();
  elements.gestureDialog.close();
}

function executeGesture(name) {
  if (name === "Thumb_Up") {
    if (elements.prompt.value.trim()) {
      sendMessage(elements.prompt.value);
      toast("Gesture: send");
    } else {
      toast("Type a message before using thumbs up.");
    }
  } else if (name === "Pointing_Up") {
    closeGesturePanel();
    elements.prompt.focus();
    toast("Gesture: message focused");
  } else if (name === "Victory") {
    speakLatestReply();
    toast("Gesture: reading latest reply");
  } else if (name === "Closed_Fist") {
    elements.stop.click();
    stopSpeech();
    toast("Gesture: stopped");
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

// Input is escaped before any tag insertion, so ">" arrives as "&gt;".
function renderMarkdownLines(lines) {
  const output = [];
  let index = 0;
  const run = (test) => {
    const collected = [];
    while (index < lines.length && test(lines[index])) collected.push(lines[index++]);
    return collected;
  };
  while (index < lines.length) {
    const line = lines[index];
    if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
    } else if (/^[-*]\s+/.test(line)) {
      output.push(`<ul>${run((item) => /^[-*]\s+/.test(item)).map((item) => `<li>${item.replace(/^[-*]\s+/, "")}</li>`).join("")}</ul>`);
    } else if (/^\d+[.)]\s+/.test(line)) {
      output.push(`<ol>${run((item) => /^\d+[.)]\s+/.test(item)).map((item) => `<li>${item.replace(/^\d+[.)]\s+/, "")}</li>`).join("")}</ol>`);
    } else if (/^&gt;\s?/.test(line)) {
      output.push(`<blockquote>${run((item) => /^&gt;\s?/.test(item)).map((item) => item.replace(/^&gt;\s?/, "")).join("<br>")}</blockquote>`);
    } else {
      const text = run((item) => item.trim()
        && !/^[-*]\s+/.test(item) && !/^\d+[.)]\s+/.test(item) && !/^&gt;\s?/.test(item) && !/^(?:-{3,}|\*{3,})\s*$/.test(item));
      if (text.length) output.push(`<p>${text.join("<br>")}</p>`);
      else index += 1;
    }
  }
  return output.join("");
}

function renderMarkdownBlock(part) {
  const trimmed = part.trim();
  if (/^%%BLOCK_\d+%%$/.test(trimmed) || /^<h[1-3]>/.test(part)) return part;
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  if (lines.length >= 2 && lines.every((line) => /^\|.*\|$/.test(line.trim())) && /^\|[\s:|-]+\|$/.test(lines[1].trim())) {
    const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    return `<div class="table-scroll"><table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
      rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  return renderMarkdownLines(lines);
}

function renderMarkdown(text = "") {
  let safe = escapeHtml(text);
  const blocks = [];
  safe = safe.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const token = `%%BLOCK_${blocks.length}%%`;
    blocks.push(`<div class="code-block"><div class="code-head"><span>${language || "code"}</span><button type="button" class="code-copy">Copy</button></div><pre><code data-language="${language}">${code.trim()}</code></pre></div>`);
    return token;
  });
  safe = safe
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\[\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>");
  safe = safe.split(/\n{2,}/).map(renderMarkdownBlock).join("");
  blocks.forEach((block, index) => {
    safe = safe.replace(`%%BLOCK_${index}%%`, block);
  });
  return safe;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function init() {
  if (!await initializeAuth()) return;
  initAgentWorkspace({ api, toast, getCsrf: () => app.auth?.csrfToken || "" });
  initSandboxWorkspace({ api, toast, project: activeProject });
  initPhysics({ api, toast });
  initLab({ api, toast, project: activeProject });
  initDemo({ api, toast, sendMessage, switchView });
  $("#demo-back-to-chat")?.addEventListener("click", () => {
    switchView("chat");
    elements.prompt.focus();
  });
  $("#lab-back-to-chat")?.addEventListener("click", () => {
    switchView("chat");
    elements.prompt.focus();
  });
  $("#sandbox-back-to-chat")?.addEventListener("click", () => {
    switchView("chat");
    elements.prompt.focus();
  });
  $("#physics-back-to-chat")?.addEventListener("click", () => {
    switchView("chat");
    elements.prompt.focus();
  });
  // The agent has no sidebar entry, so it needs its own way back.
  $("#agent-back-to-chat")?.addEventListener("click", () => {
    switchView("chat");
    elements.prompt.focus();
  });
  startSessionWatch();
  resetMarketplaceDialogs();
  bindEvents();
  const recentMarketplaceSearches = document.createElement("datalist");
  recentMarketplaceSearches.id = "marketplace-recent-searches";
  recentMarketplaceSearches.innerHTML = loadJson("evolv:marketplace-searches", [])
    .slice(0, 8).map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
  document.body.append(recentMarketplaceSearches);
  $("#marketplace-search")?.setAttribute("list", recentMarketplaceSearches.id);
  populateVoices();
  try {
    await migrateBrowserData();
    await loadServerSettings();
    app.account = await api("/api/account");
    elements.accountName.textContent = app.account.username;
    await refreshProviders();
    await refreshProjects();
  } catch (error) {
    toast(`Data startup: ${error.message}`, "error");
  }
  if (!modeDefinitions[app.settings.mode]) app.settings.mode = "standard";
  elements.think.value = app.settings.think;
  elements.mode.value = app.settings.mode;
  elements.temperature.value = app.settings.temperature;
  elements.temperatureValue.value = app.settings.temperature;
  elements.contextSize.value = String(app.settings.numCtx);
  elements.maxTokens.value = String(app.settings.maxTokens || 4096);
  elements.voiceRate.value = String(app.settings.voiceRate);
  elements.voiceRateValue.value = `${Number(app.settings.voiceRate).toFixed(1)}×`;
  elements.hearingAccuracy.value = app.settings.hearingAccuracy === "fast" ? "fast" : "enhanced";
  elements.hearingReviewMode.value = app.settings.hearingReviewMode === "always" ? "always" : "uncertain";
  elements.hearingVocabulary.value = String(app.settings.hearingVocabulary || "");
  elements.voiceToggle.classList.toggle("active", app.settings.autoSpeak);
  await initializeDesktopVoice();
  renderMessages();
  await Promise.allSettled([
    refreshHealth(), refreshModels(), refreshState(), refreshTools(), refreshMemory(),
    refreshMacros(), refreshIntelligence(), refreshObsidian(), refreshToolRecipes(), refreshMarketplace()
  ]);
  try {
    await refreshConversations({ openCurrent: true });
  } catch (error) {
    toast(`Conversations: ${error.message}`, "error");
  }
  initializeDesktopUpdates();
}

function renderDesktopUpdateStatus(status) {
  const supported = Boolean(status?.supported && window.evolvDesktopApp?.checkForUpdates);
  elements.desktopUpdateVersion.textContent = status?.currentVersion ? `v${status.currentVersion}` : "";
  elements.desktopUpdateCheck.disabled = !supported || ["checking", "downloading", "installing"].includes(status?.phase);
  elements.desktopUpdateInstall.classList.toggle("hidden", !status?.release?.available);
  elements.desktopUpdateInstall.disabled = !supported || ["checking", "downloading", "installing"].includes(status?.phase);
  elements.desktopUpdateInstall.textContent = status?.readyToInstall ? "Install & restart" : "Download & install";
  elements.desktopUpdateNotes.textContent = status?.release?.notes || "";
  elements.desktopUpdateNotes.classList.toggle("hidden", !status?.release?.notes);
  if (!supported) {
    elements.desktopUpdateStatus.textContent = "Automatic updates are available in the packaged Windows app and the Linux AppImage.";
  } else if (status.phase === "checking") {
    elements.desktopUpdateStatus.textContent = "Checking the verified GitHub releaseâ€¦";
  } else if (status.phase === "downloading") {
    elements.desktopUpdateStatus.textContent = "Downloading and verifying the updateâ€¦";
  } else if (status.phase === "ready") {
    // Worth saying plainly: the reason it finished so quickly is that most of
    // the new version was already on disk.
    elements.desktopUpdateStatus.textContent = `Evolv ${status.release.version} is verified and ready to install.${
      status.savings?.reusedBytes ? ` Downloaded ${formatBytes(status.savings.fetchedBytes)} of ${formatBytes(status.savings.totalBytes)}; the rest was reused from the copy you already have.` : ""}`;
  } else if (status.phase === "installing") {
    elements.desktopUpdateStatus.textContent = "Installing the update; Evolv will restart.";
  } else if (status.phase === "available") {
    elements.desktopUpdateStatus.textContent = `Evolv ${status.release.version} is available from GitHub.`;
  } else if (status.phase === "current") {
    elements.desktopUpdateStatus.textContent = "You have the latest stable release.";
  } else if (status.phase === "error") {
    elements.desktopUpdateStatus.textContent = `Update check failed: ${status.error || "GitHub is unavailable."}`;
  } else {
    elements.desktopUpdateStatus.textContent = `Automatic updates use ${status.repository}.`;
  }
}

async function refreshDesktopUpdateStatus({ check = false, silent = false } = {}) {
  if (!window.evolvDesktopApp?.updateStatus) {
    renderDesktopUpdateStatus({ supported: false });
    return null;
  }
  try {
    const status = check
      ? await window.evolvDesktopApp.checkForUpdates()
      : await window.evolvDesktopApp.updateStatus();
    renderDesktopUpdateStatus(status);
    if (check && status.release?.available && !silent) toast(`Evolv ${status.release.version} is ready to download.`);
    return status;
  } catch (error) {
    renderDesktopUpdateStatus({ supported: true, phase: "error", error: error.message });
    if (!silent) toast(error.message, "error");
    return null;
  }
}

function initializeDesktopUpdates() {
  refreshDesktopUpdateStatus({ silent: true });
  if (!window.evolvDesktopApp?.checkForUpdates) return;
  const lastCheck = Number(localStorage.getItem("evolv:last-update-check") || 0);
  if (Date.now() - lastCheck < 6 * 60 * 60 * 1000) return;
  setTimeout(async () => {
    localStorage.setItem("evolv:last-update-check", String(Date.now()));
    const status = await refreshDesktopUpdateStatus({ check: true, silent: true });
    if (status?.release?.available) toast(`Evolv ${status.release.version} is available in Settings.`);
  }, 4_000);
}

// Four states, not two. Ollama answering its version endpoint while holding no
// models is the state that used to show green and then fail on the first
// message, so it gets its own colour and its own instruction.
function localStatusOf(health) {
  if (!health.connected) {
    return { dot: "error", label: "Ollama offline", detail: "Start Ollama to chat", setup: "offline" };
  }
  if (!health.modelCount) {
    return {
      dot: "needs-model",
      label: "Ollama connected — model needed",
      detail: `${health.evolvModelLabel || "Evolv Local"} not installed`,
      setup: "empty"
    };
  }
  if (!health.evolvModelInstalled) {
    // Whatever they pulled themselves works fine. This is an offer, not a
    // blocker, and it must never talk anyone out of a model they already have.
    return {
      dot: "connected",
      label: "Ollama connected",
      detail: `${health.modelCount} model${health.modelCount === 1 ? "" : "s"} · Evolv Local not installed`,
      setup: "optional"
    };
  }
  if (health.evolvModelStale) {
    // Installed and working, but built before its instructions last changed.
    // Not a fault, so the dot stays green.
    return { dot: "connected", label: "Evolv Local ready", detail: "Update available", setup: "stale" };
  }
  return { dot: "connected", label: "Evolv Local ready", detail: `v${health.version}`, setup: "none" };
}

async function refreshHealth() {
  const health = await api("/api/health");
  app.health = health;
  const status = localStatusOf(health);

  for (const name of ["connected", "error", "needs-model"]) {
    elements.healthDot.classList.toggle(name, status.dot === name);
  }
  elements.healthLabel.textContent = status.label;
  elements.healthDetail.textContent = status.detail;
  renderLocalSetup(status, health);
  return health;
}

function renderLocalSetup(status, health) {
  if (!elements.localSetup) return;
  const installing = health.install?.phase === "pulling" || health.install?.phase === "creating";
  const label = health.evolvModelLabel || "Evolv Local";

  const dismissible = status.setup === "optional" || status.setup === "stale";
  if (status.setup === "none" || (dismissible && app.dismissedLocalSetup)) {
    if (!installing) return elements.localSetup.classList.add("hidden");
  }

  // What this machine can actually hold. Offering the biggest build to a laptop
  // that will swap on it is how people decide local models are useless, so the
  // server picks from the catalogue by memory and the offer follows.
  const offered = health.recommendedLabel || label;
  const size = health.recommendedBytes ? ` (about ${formatBytes(health.recommendedBytes)})` : "";

  // Evolv Local is a ladder, and this machine gets every rung it can hold: a
  // small fast one and a large careful one are useful for different questions,
  // and fetching them in one run beats running the installer three times.
  const missing = health.missingModels || [];
  const bulk = missing.length > 1;
  const bulkSize = health.missingBytes ? ` (about ${formatBytes(health.missingBytes)} in total)` : "";
  const builds = `${missing.length} Evolv Local builds`;

  const copy = {
    offline: ["Ollama isn't running.", "Start Ollama on this computer, then refresh."],
    empty: ["Ollama is running, but no AI models are installed.",
      bulk ? `Evolv installs ${builds}${bulkSize} — a small fast one for quick questions and larger ones for careful work. You can chat as soon as the first finishes.`
        : `Install ${offered}${size} to start chatting — it is the largest build this computer has memory for.`],
    optional: [`Evolv Local isn't installed yet.`,
      bulk ? `Your existing models still work. Evolv installs ${builds}${bulkSize}, every one this computer has memory for.`
        : `Your existing models still work. ${offered}${size} is the largest build this computer has memory for.`],
    stale: [`${label} was built from an older version of its instructions.`,
      "Rebuilding takes a few seconds — the model itself is already downloaded, and nothing is re-downloaded."],
    none: health.recommendedUpgrade
      ? [`${label} is ready, and this computer could run more.`,
        bulk
          ? `${builds}${bulkSize} are still missing — the same assistant on larger bases, better at multi-step reasoning and tool use. Installing them leaves ${label} in place.`
          : `${offered}${size} is the same assistant on a larger base — better at multi-step reasoning and tool use. Installing it leaves ${label} in place.`]
      : [`${label} is ready.`, "You can start chatting."]
  }[status.setup];

  elements.localSetupTitle.textContent = copy[0];
  elements.localSetupDetail.textContent = copy[1];
  // Nothing to install while Ollama is unreachable — there is nowhere to put it.
  elements.installButton.classList.toggle("hidden", status.setup === "offline" || (status.setup === "none" && !health.recommendedUpgrade));
  elements.installButton.textContent = status.setup === "stale"
    ? `Rebuild ${label}`
    : bulk
      ? `Install ${builds}`
      : status.setup === "none"
        ? `Install ${offered}`
        : health.baseModelInstalled && !health.evolvModelInstalled
          ? `Finish setting up ${label}`
          : `Get ${offered}`;
  // A rebuild is one named build; everything else installs every rung this
  // machine can hold, in one run.
  elements.installButton.dataset.models = status.setup === "stale"
    ? (health.evolvModel || "")
    : (missing.length ? missing.join(",") : health.recommendedModel || "");
  elements.localSetup.classList.remove("hidden");

  if (installing) attachToInstall();
}

function formatProgress(snapshot) {
  if (!snapshot.total) return "";
  return `${formatBytes(snapshot.completed)} / ${formatBytes(snapshot.total)}`;
}

function renderInstallProgress(snapshot) {
  const running = snapshot.phase === "pulling" || snapshot.phase === "creating";
  elements.installProgress.classList.toggle("hidden", !running);
  elements.installButton.disabled = running;
  elements.installPhase.textContent = snapshot.phase === "creating"
    ? "Configuring Evolv Local…"
    : "Downloading Evolv Local";
  elements.installBytes.textContent = formatProgress(snapshot);
  elements.installStatus.textContent = snapshot.status || "";
  // Percentages come from Ollama's own byte counts; when it has not reported
  // any yet the bar sweeps instead of inventing a number.
  const known = typeof snapshot.percent === "number";
  elements.installBar.classList.toggle("indeterminate", running && !known);
  elements.installBar.style.width = known ? `${snapshot.percent}%` : "";

  const failed = snapshot.phase === "error";
  elements.installError.classList.toggle("hidden", !failed);
  if (failed) {
    elements.localSetupTitle.textContent = snapshot.error?.message || "Evolv Local couldn't finish downloading.";
    elements.localSetupDetail.textContent = "Nothing was changed. You can try again.";
    elements.installErrorDetail.textContent = snapshot.error?.detail || "";
    elements.installButton.textContent = "Try again";
  }
}

// One install at a time. The server enforces it too — this only keeps a second
// click from opening a second stream to the same run.
let installStream = null;

async function attachToInstall() {
  if (installStream) return installStream;
  installStream = (async () => {
    try {
      const response = await fetch("/api/ollama/install-evolv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Whichever builds the panel offered. An empty value lets the server
        // choose its default, which is what a rejoining client sends.
        body: JSON.stringify(elements.installButton?.dataset.models
          ? { models: elements.installButton.dataset.models.split(",").filter(Boolean) }
          : {})
      });
      if (!response.ok || !response.body) throw new Error(`Install failed to start (${response.status}).`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let last = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (!line) continue;
          last = JSON.parse(line);
          renderInstallProgress(last);
        }
      }

      if (last?.phase === "ready") await finishInstall();
      else if (last?.cancelled) toast("Installation cancelled.");
    } catch (error) {
      renderInstallProgress({ phase: "error", error: { message: "Evolv Local couldn't finish downloading.", detail: error.message } });
    } finally {
      installStream = null;
      elements.installButton.disabled = false;
    }
  })();
  return installStream;
}

async function finishInstall() {
  const health = await refreshHealth();
  await refreshModels();
  // Select it only if the person has not chosen something else in the meantime.
  const target = health.evolvModel;
  if (target && app.models.some((model) => model.name === target) && (app.settings.model === "auto" || !app.settings.model)) {
    app.settings.model = target;
    elements.model.value = target;
    configureReasoning(target);
    saveLocal();
  }
  elements.localSetup.classList.add("hidden");
  toast(`${health.evolvModelLabel || "Evolv Local"} is ready.`);
}

function modelOption(model) {
  const badges = [
    model.capabilities?.includes("tools") ? "🔧" : "",
    model.capabilities?.includes("vision") ? "👁" : "",
    model.capabilities?.includes("thinking") ? "🧠" : ""
  ].filter(Boolean).join("");
  const detail = [model.parameterSize, formatBytes(model.size)].filter(Boolean).join(" · ");
  // The size is known before the model is ever run, so a model this computer
  // cannot hold says so in the list rather than failing mid-reply.
  const fit = { over: "⚠ too big for this computer", tight: "⚠ tight fit" }[model.fit?.level] || "";
  // What happened last time. A model that has failed twice running says so
  // here, rather than being picked again because the list looks the same.
  const failing = model.health?.failing ? `⚠ ${model.health.reason}` : "";
  return new Option([model.name, detail, badges, fit, failing].filter(Boolean).join("  ·  "), model.name);
}

function addModelGroup(label, models) {
  if (!models.length) return;
  const group = document.createElement("optgroup");
  group.label = label;
  for (const model of models) group.append(modelOption(model));
  elements.model.add(group);
}

function updateFavoriteButton() {
  const model = app.models.find((item) => item.name === elements.model.value);
  const favorite = Boolean(model?.favorite);
  elements.favoriteModel.textContent = favorite ? "★" : "☆";
  elements.favoriteModel.setAttribute("aria-pressed", String(favorite));
  const action = favorite ? "Remove this model from favourites" : "Add this model to favourites";
  elements.favoriteModel.setAttribute("aria-label", action);
  elements.favoriteModel.title = action;
  // Auto is a routing choice rather than a model, so there is nothing to star.
  elements.favoriteModel.disabled = !model;
}

async function toggleFavoriteModel() {
  const model = app.models.find((item) => item.name === elements.model.value);
  if (!model) return;
  try {
    await api("/api/models/favorite", {
      method: "POST",
      body: JSON.stringify({ provider: app.settings.provider || "ollama", model: model.name, favorite: !model.favorite })
    });
    await refreshModels();
    toast(model.favorite ? `${model.name} removed from favourites` : `${model.name} added to favourites`);
  } catch (error) {
    toast(error.message, "error");
  }
}

// Said once, when the model is chosen, rather than after a reply has already
// failed for a reason the person could have been told about up front.
function warnAboutFit() {
  const model = app.models.find((item) => item.name === elements.model.value);
  if (!model) return;
  // The record of real failures outranks the estimate: it already happened.
  if (model.health?.failing) return toast(`${model.name}: ${model.health.reason}`, "error");
  if (model.fit?.note) toast(`${model.name}: ${model.fit.note}`, model.fit.level === "over" ? "error" : "");
}

async function refreshModels() {
  try {
    const { models } = await api(`/api/models?provider=${encodeURIComponent(app.settings.provider || "ollama")}`);
    app.models = models;
    elements.model.innerHTML = "";
    elements.model.add(new Option("Auto · Balanced", "auto"));
    if (!models.length) {
      // "No manual models available" read as a detail about the dropdown. It is
      // not: with no models there is nothing to chat with at all, and the empty
      // selector is the second place that has to say so.
      const empty = new Option("No local models installed", "");
      empty.disabled = true;
      elements.model.add(empty);
      elements.model.value = "auto";
      app.settings.model = "auto";
      configureReasoning("auto");
      updateFavoriteButton();
      return;
    }
    // Favourites first, under a heading, so a long list of pulled models stops
    // burying the two or three anyone actually uses.
    const favorites = models.filter((model) => model.favorite);
    if (favorites.length) {
      addModelGroup("Favourites", favorites);
      addModelGroup("All models", models.filter((model) => !model.favorite));
    } else {
      for (const model of models) elements.model.add(modelOption(model));
    }
    const remembered = app.settings.model === "auto" || models.some((model) => model.name === app.settings.model) ? app.settings.model : "auto";
    elements.model.value = remembered;
    app.settings.model = remembered;
    configureReasoning(remembered);
    updateFavoriteButton();
    saveLocal();
  } catch (error) {
    const provider = app.providers.find((item) => item.id === app.settings.provider);
    const unavailable = error.code === "PROVIDER_AUTH_FAILED"
      ? `${provider?.name || "Provider"} key unavailable — replace it in Settings`
      : "Current provider unavailable";
    elements.model.innerHTML = '<option value="auto">Auto · Balanced</option>';
    const unavailableOption = new Option(unavailable, "");
    unavailableOption.disabled = true;
    elements.model.add(unavailableOption);
    elements.model.value = "auto";
    app.settings.model = "auto";
    configureReasoning("auto");
    app.models = [];
    updateFavoriteButton();
    if (error.code === "PROVIDER_AUTH_FAILED") refreshProviders().catch(() => {});
    toast(error.message, "error");
  }
}

async function refreshProviders() {
  const payload = await api("/api/providers");
  app.providers = payload.providers || [];
  elements.provider.innerHTML = "";
  const available = app.providers.filter((provider) => provider.id === "ollama" || provider.configured);
  for (const provider of available) elements.provider.add(new Option(provider.name, provider.id));
  if (!available.some((provider) => provider.id === app.settings.provider)) app.settings.provider = "ollama";
  elements.provider.value = app.settings.provider;
  app.intelligenceModels = [];
  renderProviderSettings();
}

function defaultModelPreference(providerId, model) {
  const local = providerId === "ollama";
  const billions = Number.parseFloat(String(model.parameterSize || "").match(/[\d.]+/)?.[0] || "0");
  return {
    enabledAuto: true,
    quality: local ? (billions >= 30 ? 5 : billions >= 13 ? 4 : billions >= 7 ? 3 : 2) : 4,
    speed: local ? (billions >= 30 ? 1 : billions >= 13 ? 2 : billions >= 7 ? 3 : 4) : 3,
    cost: local ? 0 : 3,
    privacy: local ? 5 : 2
  };
}

async function loadIntelligenceModels() {
  const providers = app.providers.filter((provider) => provider.id === "ollama" || provider.configured);
  const results = await Promise.allSettled(providers.map(async (provider) => ({
    provider: provider.id,
    models: ((await api(`/api/providers/${encodeURIComponent(provider.id)}/models`)).models || []).slice(0, 100)
  })));
  app.intelligenceModels = results.flatMap((result) => result.status === "fulfilled"
    ? result.value.models.map((model) => ({ ...model, provider: result.value.provider })) : []).slice(0, 200);
}

async function refreshIntelligence({ refreshModels = false } = {}) {
  if (!$("#intelligence-view")) return;
  [app.intelligence, app.evolution] = await Promise.all([api("/api/intelligence"), api("/api/evolution")]);
  if (refreshModels || !app.intelligenceModels.length) await loadIntelligenceModels();
  renderIntelligence();
  // The roster is the server's to state. Duplicating it here would be a second
  // copy of who the specialists are, free to drift from the one that runs.
  await renderAgentModelPins().catch(() => {});
}

// What each specialist may reach, said in words rather than a policy name.
const REACH_LABEL = {
  all: "reads, and may propose changes",
  read: "reads only",
  none: "no tools — reasons over what other steps found"
};

async function renderAgentModelPins() {
  const container = $("#agent-model-pins");
  if (!container) return;
  const { agents } = await api("/api/agents");
  const provider = app.settings.provider || "ollama";
  container.innerHTML = agents.map((agent) => {
    // The models Evolv currently has loaded, plus whatever is already pinned —
    // a pin from another provider must not vanish because the chat provider
    // changed since it was set.
    const options = app.models.map((model) => `${provider}:${model.name}`);
    if (agent.model && !options.includes(agent.model)) options.unshift(agent.model);
    return `
      <div class="agent-model-pin">
        <label for="agent-model-${escapeHtml(agent.id)}">
          <strong>${escapeHtml(agent.name)}</strong>
          <small>${escapeHtml(agent.description)}</small>
          <span class="reach">${escapeHtml(REACH_LABEL[agent.tools] || agent.tools || "")}</span>
        </label>
        <select id="agent-model-${escapeHtml(agent.id)}" data-agent-model="${escapeHtml(agent.id)}">
          <option value="">The goal's own model</option>
          ${options.map((value) => `<option value="${escapeHtml(value)}"${value === agent.model ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}
        </select>
      </div>`;
  }).join("");
}

function renderIntelligence() {
  const data = app.intelligence;
  if (!data) return;
  const settings = data.settings || {};
  $("#route-count").textContent = data.stats?.routed || 0;
  $("#route-success").textContent = `${data.stats?.routingSuccess || 0}%`;
  $("#memory-proposal-count").textContent = data.stats?.pendingMemories || 0;
  $("#evaluation-case-count").textContent = data.stats?.evaluationCases || 0;
  elements.intelligenceDot?.classList.toggle("hidden", !(data.stats?.pendingMemories));
  $("#auto-routing-enabled").checked = settings.autoRouting !== false;
  $("#auto-memory-enabled").checked = settings.autoMemory !== false;
  $("#evaluation-limit").value = String(settings.evaluationLimit || 10);
  $("#monthly-cost-limit").value = String(settings.monthlyCostLimit || 0);
  const cloudProviders = app.providers.filter((provider) => provider.requiresKey && provider.configured);
  $("#auto-cloud-providers").innerHTML = cloudProviders.length ? cloudProviders.map((provider) => `
    <label><input type="checkbox" data-auto-cloud="${escapeHtml(provider.id)}" ${(settings.autoCloudProviders || []).includes(provider.id) ? "checked" : ""} /> ${escapeHtml(provider.name)}</label>
  `).join("") : '<span class="settings-note">No cloud providers are configured. Auto stays local.</span>';
  $("#vault-cloud-providers").innerHTML = cloudProviders.length ? cloudProviders.map((provider) => `
    <label><input type="checkbox" data-vault-cloud="${escapeHtml(provider.id)}" ${(settings.vaultCloudProviders || []).includes(provider.id) ? "checked" : ""} /> ${escapeHtml(provider.name)} <small>may create charges</small></label>
  `).join("") : '<span class="settings-note">No cloud provider can receive vault excerpts.</span>';
  $("#project-cloud-providers").innerHTML = cloudProviders.length ? cloudProviders.map((provider) => `
    <label><input type="checkbox" data-project-cloud="${escapeHtml(provider.id)}" ${(settings.projectCloudProviders || []).includes(provider.id) ? "checked" : ""} /> ${escapeHtml(provider.name)} <small>may create charges</small></label>
  `).join("") : '<span class="settings-note">No cloud provider can receive project sources.</span>';

  const preferences = new Map((data.modelPreferences || []).map((item) => [`${item.providerId}:${item.modelId}`, item]));
  $("#intelligence-models").innerHTML = app.intelligenceModels.length ? app.intelligenceModels.map((model) => {
    const preference = { ...defaultModelPreference(model.provider, model), ...preferences.get(`${model.provider}:${model.id}`) };
    return `<article class="intelligence-model" data-provider="${escapeHtml(model.provider)}" data-model="${escapeHtml(model.id)}">
      <div><strong>${escapeHtml(model.displayName || model.name)}</strong><small>${escapeHtml(model.provider)} · ${escapeHtml((model.capabilities || []).join(", ") || "completion")}</small></div>
      <label><input data-pref="enabledAuto" type="checkbox" ${preference.enabledAuto ? "checked" : ""} /> Auto</label>
      ${["quality", "speed", "cost", "privacy"].map((field) => `<label><span>${field}</span><input data-pref="${field}" type="number" min="${field === "cost" ? 0 : 1}" max="5" value="${preference[field]}" /></label>`).join("")}
      <button class="secondary-button save-model-preference" type="button">Save</button>
    </article>`;
  }).join("") : '<p class="settings-note">No models were discovered.</p>';

  const pending = (data.memoryProposals || []).filter((item) => item.status === "pending");
  $("#memory-proposal-list").innerHTML = pending.length ? pending.map((proposal) => `
    <article class="memory-proposal" data-proposal-id="${escapeHtml(proposal.id)}">
      <label class="proposal-select"><input type="checkbox" data-memory-select /> ${escapeHtml(proposal.action.toUpperCase())} · ${Math.round(proposal.confidence * 100)}% confidence</label>
      <select data-proposal-field="type">${["project", "task", "decision", "preference", "note"].map((type) => `<option value="${type}" ${type === proposal.type ? "selected" : ""}>${type}</option>`).join("")}</select>
      <input data-proposal-field="title" maxlength="200" value="${escapeHtml(proposal.title)}" />
      <textarea data-proposal-field="body" rows="4" maxlength="10000">${escapeHtml(proposal.body)}</textarea>
      <p>${escapeHtml(proposal.rationale || "Proposed from the completed conversation.")}</p>
      <div class="data-actions"><button class="primary-button memory-proposal-approve" type="button">Approve</button><button class="secondary-button memory-proposal-reject" type="button">Reject</button></div>
    </article>
  `).join("") : '<div class="empty-panel"><h2>Inbox clear</h2><p>New memories found after chats will wait here for your review.</p></div>';

  $("#routing-history").innerHTML = (data.routing || []).length ? data.routing.slice(0, 20).map((route) => `
    <article class="route-history-item"><strong>${escapeHtml(route.providerId)} · ${escapeHtml(route.modelId)}</strong><span>${escapeHtml(route.status)} · score ${route.score}</span><p>${escapeHtml((route.reasons || []).join(" · "))}</p><small>${new Date(route.createdAt).toLocaleString()}${route.cloud ? " · CLOUD" : " · LOCAL"}</small></article>
  `).join("") : '<p class="settings-note">Auto routing decisions will appear here.</p>';
  const pendingUpgrades = (data.upgrades || []).filter((item) => item.status === "pending");
  const upgradeCards = pendingUpgrades.map((upgrade) => `
    <article class="route-history-item intelligence-upgrade" data-upgrade-id="${escapeHtml(upgrade.id)}">
      <strong>${escapeHtml(upgrade.payload?.summary || `${upgrade.kind} upgrade`)}</strong><span>PENDING REVIEW</span>
      <p>${escapeHtml(upgrade.payload?.rationale || "Evidence-backed intelligence adjustment")}</p>
      <small>${upgrade.payload?.evidence?.positive ?? 0}/${upgrade.payload?.evidence?.rated ?? 0} helpful ratings</small>
      <div class="data-actions"><button class="primary-button approve-intelligence-upgrade" type="button">Approve</button><button class="secondary-button reject-intelligence-upgrade" type="button">Reject</button></div>
    </article>`).join("");
  const evaluationCards = (data.evaluationRuns || []).map((run) => `
    <article class="route-history-item"><strong>${escapeHtml(run.modelId)}</strong><span>${escapeHtml(run.status)}</span><p>${escapeHtml(run.summary?.reason || "Evaluation in progress")}</p><small>${run.summary?.cases || 0} cases · ${run.summary?.recommended ? "RECOMMENDED" : "NOT RECOMMENDED"}</small></article>
  `).join("");
  $("#evaluation-history").innerHTML = upgradeCards || evaluationCards
    ? `${upgradeCards}${evaluationCards}`
    : '<p class="settings-note">Rate answers, generate an upgrade, then run a blind comparison.</p>';
  renderEvolutionEvidence();
}

function renderEvolutionEvidence() {
  const data = app.evolution;
  if (!data || !$("#strategy-version-list")) return;
  $("#evolution-run-count").textContent = `${data.stats?.evaluatedRuns || 0} RUNS`;
  $("#recurring-failure-count").textContent = `${data.stats?.recurringFailures || 0} RECURRING`;
  $("#run-evidence-history").innerHTML = (data.evaluations || []).length ? data.evaluations.slice(0, 12).map((item) => {
    const metrics = item.metrics || {};
    const quality = metrics.quality == null ? "awaiting rating" : metrics.quality ? "helpful" : "needs work";
    return `<article class="route-history-item">
      <strong>${escapeHtml(item.evidence?.provider || "unknown")} · ${escapeHtml(item.evidence?.model || "unknown")}</strong><span>${escapeHtml(item.evidence?.terminalState || item.status)}</span>
      <p>${metrics.toolCalls || 0} tool calls · ${metrics.toolFailures || 0} failures · ${item.evidence?.citationCount || 0} citations · ${Math.round(metrics.latencyMs || 0)} ms</p>
      <small>${metrics.tokens || 0} estimated tokens · ${metrics.estimatedCostUnits || 0} cost units · ${quality} · no judge call</small>
    </article>`;
  }).join("") : '<p class="settings-note">Completed and failed agent runs will appear here.</p>';
  $("#failure-pattern-list").innerHTML = (data.failures || []).length ? data.failures.map((item) => `
    <label class="route-history-item failure-pattern-item">
      <span><input type="checkbox" data-failure-pattern="${escapeHtml(item.id)}" /> ${escapeHtml(item.category.toUpperCase())}</span><strong>${item.occurrences}×</strong>
      <p>${escapeHtml(item.summary)}</p><small>${escapeHtml(item.status)} · last seen ${new Date(item.lastSeenAt).toLocaleString()}</small>
    </label>
  `).join("") : '<p class="settings-note">No failure patterns have been reported.</p>';

  const runs = data.benchmarkRuns || [];
  $("#strategy-version-list").innerHTML = (data.strategies || []).map((strategy) => {
    const benchmark = runs.find((item) => item.strategyId === strategy.id && item.status === "complete");
    const summary = benchmark?.summary;
    const canApprove = strategy.status === "candidate" && summary?.recommended;
    return `<article class="memory-proposal strategy-version" data-strategy-id="${escapeHtml(strategy.id)}" data-benchmark-id="${escapeHtml(benchmark?.id || "")}">
      <div class="mind-card-heading"><div><strong>v${strategy.version} · ${escapeHtml(strategy.name)}</strong><p>${escapeHtml(strategy.rationale || "No rationale supplied.")}</p></div><span class="model-badge">${escapeHtml(strategy.status.toUpperCase())}</span></div>
      ${strategy.instruction ? `<pre class="strategy-instruction">${escapeHtml(strategy.instruction)}</pre>` : '<p class="settings-note">Baseline adds no extra behavioral instruction.</p>'}
      ${summary ? `<p class="settings-note">Candidate ${Math.round((summary.candidateScore || 0) * 100)}% vs baseline ${Math.round((summary.baselineScore || 0) * 100)}% · ${summary.wins} wins · ${summary.losses} losses · ${summary.criticalRegression ? "CRITICAL REGRESSION" : "no critical regression"}</p>` : ""}
      ${strategy.status === "candidate" ? `<div class="data-actions"><button class="secondary-button benchmark-strategy" type="button">Run 10-call benchmark</button>${canApprove ? '<button class="primary-button approve-strategy" type="button">Approve tested strategy</button>' : ""}<button class="secondary-button reject-strategy" type="button">Reject</button></div>` : ""}
    </article>`;
  }).join("");
}

async function reviewMemoryProposal(card, decision) {
  const proposalId = card.dataset.proposalId;
  await api(`/api/memory-proposals/${encodeURIComponent(proposalId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      decision,
      type: card.querySelector('[data-proposal-field="type"]').value,
      title: card.querySelector('[data-proposal-field="title"]').value,
      body: card.querySelector('[data-proposal-field="body"]').value
    })
  });
  await Promise.all([refreshIntelligence(), refreshMemory()]);
  toast(decision === "approved" ? "Memory approved and added to active context." : "Memory proposal rejected.");
}

function renderProviderSettings() {
  if (!elements.providerSettingsList) return;
  elements.providerSettingsList.innerHTML = app.providers.map((provider) => {
    const cloudDisabled = provider.requiresKey && !provider.secretStorageAvailable;
    const custom = provider.id === "custom";
    const ollama = provider.id === "ollama";
    return `
      <section class="provider-card" data-provider-card="${escapeHtml(provider.id)}">
        <div class="provider-card-head">
          <strong>${escapeHtml(provider.name)}</strong>
          <span class="provider-status">${escapeHtml(provider.status || (provider.configured ? "configured" : "not configured"))}</span>
        </div>
        ${provider.statusMessage ? `<p class="settings-note">${escapeHtml(provider.statusMessage)}</p>` : ""}
        <div class="provider-card-fields">
          ${provider.requiresKey ? `<label class="wide"><span class="field-label">API KEY</span><input data-provider-key type="password" autocomplete="off" placeholder="${provider.configured ? "Enter a new key to replace the saved key" : "Paste API key"}" ${cloudDisabled ? "disabled" : ""}></label>` : ""}
          ${(custom || ollama) ? `<label class="wide"><span class="field-label">BASE URL</span><input data-provider-url type="url" value="${escapeHtml(provider.baseUrl || "")}" ${cloudDisabled ? "disabled" : ""}></label>` : ""}
        </div>
        ${custom ? `<div class="provider-capabilities">
          <label><input data-provider-capability="tools" type="checkbox" ${provider.capabilities?.tools ? "checked" : ""}> Tools</label>
          <label><input data-provider-capability="vision" type="checkbox" ${provider.capabilities?.vision ? "checked" : ""}> Vision</label>
          <label><input data-provider-capability="thinking" type="checkbox" ${provider.capabilities?.thinking ? "checked" : ""}> Reasoning</label>
        </div>` : ""}
        ${cloudDisabled ? `<p class="settings-note">${escapeHtml(provider.secretStorageDescription)}</p>` : ""}
        <div class="data-actions">
          <button class="secondary-button provider-save" type="button" ${cloudDisabled ? "disabled" : ""}>Save</button>
          <button class="secondary-button provider-test" type="button" ${!provider.configured && !ollama ? "disabled" : ""}>Test</button>
          ${provider.configured && !ollama ? '<button class="secondary-button provider-delete" type="button">Delete key</button>' : ""}
        </div>
      </section>
    `;
  }).join("");
}

async function providerAction(button, action) {
  const card = button.closest("[data-provider-card]");
  const providerId = card.dataset.providerCard;
  button.disabled = true;
  try {
    if (action === "save") {
      const capabilities = Object.fromEntries([...card.querySelectorAll("[data-provider-capability]")]
        .map((input) => [input.dataset.providerCapability, input.checked]));
      const apiKey = card.querySelector("[data-provider-key]")?.value;
      const baseUrl = card.querySelector("[data-provider-url]")?.value;
      await api(`/api/providers/${encodeURIComponent(providerId)}/credentials`, {
        method: "PUT",
        body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), capabilities })
      });
      toast(`${providerId} settings saved.`);
    } else if (action === "test") {
      const result = await api(`/api/providers/${encodeURIComponent(providerId)}/test`, { method: "POST", body: "{}" });
      toast(`${result.modelCount} models available.`);
    } else if (action === "delete") {
      await api(`/api/providers/${encodeURIComponent(providerId)}/credentials`, { method: "DELETE" });
      toast("Provider key deleted.");
    }
    await refreshProviders();
    await refreshModels();
  } catch (error) {
    if (error.code === "PROVIDER_AUTH_FAILED") await refreshProviders().catch(() => {});
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function configureReasoning(modelName) {
  if (modelName === "auto") {
    elements.attachButton?.classList.remove("hidden");
    elements.think.innerHTML = '<option value="auto">Automatic</option>';
    elements.think.disabled = true;
    elements.think.value = "auto";
    return;
  }
  const model = app.models.find((item) => item.name === modelName);
  const previous = app.settings.think;
  const supportsVision = Boolean(model?.capabilities?.includes("vision"));
  elements.attachButton?.classList.toggle("hidden", !supportsVision);
  if (!supportsVision && app.attachments.length) {
    app.attachments = [];
    renderAttachments();
  }
  elements.think.innerHTML = "";

  if (!model?.supportsThinking) {
    elements.think.add(new Option("Not supported", "false"));
    elements.think.disabled = true;
    app.settings.think = "false";
  } else if (model.usesThinkingLevels) {
    elements.think.add(new Option("Low", "low"));
    elements.think.add(new Option("Medium", "medium"));
    elements.think.add(new Option("High", "high"));
    elements.think.disabled = false;
    app.settings.think = ["low", "medium", "high"].includes(previous) ? previous : "medium";
  } else {
    elements.think.add(new Option("Off", "false"));
    elements.think.add(new Option("On", "true"));
    elements.think.disabled = false;
    app.settings.think = previous === "false" ? "false" : "true";
  }

  elements.think.value = app.settings.think;
  saveLocal();
}

async function refreshState() {
  app.state = await api("/api/state");
  const active = app.state.versions.find((version) => version.id === app.state.activeVersionId);
  elements.activeVersion.textContent = `v${active?.number || 1}`;
  elements.proposalDot.classList.toggle("hidden", !app.state.pendingProposal);
  renderEvolution();
  renderVersions();
  renderMind();
}

function renderMessages() {
  elements.welcome.classList.toggle("hidden", app.messages.length > 0);
  elements.messages.querySelectorAll(".message").forEach((message) => message.remove());
  app.messages.forEach((message, index) => elements.messages.append(messageNode(message, index)));
  scrollBottom();
}

function messageNode(message, index) {
  const node = document.createElement("article");
  node.className = `message ${message.role}`;
  node.dataset.index = index;
  const isAssistant = message.role === "assistant";
  node.innerHTML = `
    <div class="message-head">
      <div class="message-author">
        <span class="author-mark"><span>${isAssistant ? "E" : "Y"}</span></span>
        ${isAssistant ? "EVOLV" : "YOU"}
      </div>
      ${isAssistant && message.model ? `<span class="model-badge">${escapeHtml(message.model)}</span>` : ""}
      ${isAssistant && message.knowledge?.length ? `<span class="memory-badge">${message.knowledge.length} knowledge</span>` : ""}
      ${isAssistant && message.memory?.length ? `<span class="memory-badge">${message.memory.length} memor${message.memory.length === 1 ? "y" : "ies"}</span>` : ""}
    </div>
    ${isAssistant && message.routing ? `<div class="route-card ${message.routing.cloud ? "cloud" : "local"} ${message.routing.fallback?.used ? "fallback" : ""}">
      <strong>${message.routing.fallback?.used ? "FALLBACK USED" : (message.routing.automatic ? "AUTO ROUTE" : "MANUAL")}</strong>
      <span>${escapeHtml(message.routing.provider || message.provider || "")} · ${escapeHtml(message.routing.model || message.model || "")}</span>
      <small>${message.routing.fallback?.used ? `${escapeHtml(message.routing.fallback.message || "A preferred provider was unavailable.")}<br>` : ""}${escapeHtml((message.routing.reasons || []).join(" · "))}${message.routing.cloud ? " · Cloud processing" : " · Local processing"}</small>
    </div>` : ""}
    ${isAssistant && message.agentRun ? `<div class="agent-run-card ${escapeHtml(message.agentRun.state || "executing")}">
      <strong>AGENT RUN</strong>
      <span>${escapeHtml(String(message.agentRun.state || "executing").replaceAll("_", " "))}</span>
      <small>${message.agentRun.budgets ? `${Number(message.agentRun.budgets.usedToolCalls || 0)}/${Number(message.agentRun.budgets.maxToolCalls || 0)} tools; ${Number(message.agentRun.budgets.usedTokens || 0)}/${Number(message.agentRun.budgets.maxTokens || 0)} estimated tokens` : "Durable checkpoints enabled"}</small>
      ${["executing", "planning", "observing", "evaluating", "revising"].includes(message.agentRun.state) ? `<div class="agent-run-actions">
        <button class="secondary-button agent-run-action" data-action="pause" data-run-id="${escapeHtml(message.agentRun.id)}" type="button">Pause</button>
        <button class="secondary-button agent-run-action" data-action="cancel" data-run-id="${escapeHtml(message.agentRun.id)}" type="button">Cancel</button>
      </div>` : message.agentRun.state === "paused" ? `<div class="agent-run-actions">
        <button class="primary-button agent-run-action" data-action="resume" data-run-id="${escapeHtml(message.agentRun.id)}" type="button">Resume</button>
        <button class="secondary-button agent-run-action" data-action="cancel" data-run-id="${escapeHtml(message.agentRun.id)}" type="button">Cancel</button>
      </div>` : ""}
    </div>` : ""}
    ${isAssistant ? `<details class="thinking ${message.thinking ? "" : "hidden"}">
      <summary>REASONING TRACE</summary>
      <div class="thinking-text">${escapeHtml(message.thinking || "")}</div>
    </details>` : ""}
    ${isAssistant && message.notices?.length ? message.notices.map((notice) =>
      `<p class="message-notice">${escapeHtml(notice)}</p>`
    ).join("") : ""}
    ${isAssistant && message.vault?.withheld ? '<p class="message-notice">Obsidian memory was withheld from this cloud provider.</p>' : ""}
    ${!isAssistant && message.images?.length ? `<div class="message-images">${message.images.map((image, imageIndex) =>
      `<img src="data:image/jpeg;base64,${image}" alt="Attached image ${imageIndex + 1}" loading="lazy" />`
    ).join("")}</div>` : ""}
    <div class="message-content">${renderMarkdown(message.content)}${message.streaming ? '<span class="typing-cursor"></span>' : ""}</div>
    ${isAssistant && message.memory?.some((item) => item.path) ? `<div class="memory-citations">${message.memory.filter((item) => item.path).map((item) => `
      <div class="memory-citation">
        <span>${escapeHtml(item.title)} / ${escapeHtml(item.path)}${item.heading ? ` / ${escapeHtml(item.heading)}` : ""}</span>
        <button class="secondary-button open-memory-note" data-note-id="${escapeHtml(item.id)}" type="button">Open</button>
      </div>`).join("")}</div>` : ""}
    ${isAssistant && message.knowledge?.some((item) => item.citation) ? `<div class="project-citations">${message.knowledge.filter((item) => item.citation).map((item) => `
      <div class="project-citation">${escapeHtml(item.citation.title || item.title)}${item.citation.path ? ` / ${escapeHtml(item.citation.path)}` : ""} / ${escapeHtml(item.citation.locator || "source")}</div>
    `).join("")}</div>` : ""}
    ${isAssistant && message.tools?.length ? `<div class="tool-activities">${message.tools.map((tool) => `
      <details class="tool-activity">
        <summary><strong>${escapeHtml(tool.name || "tool")}</strong><span>${escapeHtml(tool.status || "requested")}${tool.durationMs ? ` · ${tool.durationMs}ms` : ""}</span></summary>
        <pre>${escapeHtml(JSON.stringify({ arguments: tool.arguments, output: tool.output }, null, 2))}</pre>
        ${tool.status === "approval_required" && tool.runId ? `<div class="tool-activity-actions">
          <button class="primary-button tool-run-decision" data-run-id="${escapeHtml(tool.runId)}" data-decision="approved" type="button">Approve action</button>
          <button class="secondary-button tool-run-decision" data-run-id="${escapeHtml(tool.runId)}" data-decision="rejected" type="button">Reject</button>
        </div>` : ""}
      </details>
    `).join("")}</div>` : ""}
    ${!isAssistant && !message.streaming ? `<div class="message-actions">
      <button class="feedback-button edit-button" title="Edit and resend" aria-label="Edit and resend this message">✎</button>
      <button class="feedback-button copy-button" title="Copy" aria-label="Copy this message">⧉</button>
    </div>` : ""}
    ${isAssistant && !message.streaming ? `<div class="message-actions">
      <button class="feedback-button ${message.feedback === "up" ? "selected" : ""}" data-rating="up" title="Helpful">↑</button>
      <button class="feedback-button ${message.feedback === "down" ? "selected" : ""}" data-rating="down" title="Needs work">↓</button>
      <button class="feedback-button speak-button" title="Read aloud" aria-label="Read this response aloud">◖</button>
      <button class="feedback-button copy-button" title="Copy" aria-label="Copy this response">⧉</button>
      ${index === app.messages.length - 1 || ["error", "interrupted", "limit"].includes(message.status) ? `
        <button class="feedback-button regen-button" title="Regenerate response" aria-label="Regenerate response">↻</button>` : ""}
    </div>` : ""}
  `;
  node.querySelectorAll(".feedback-button").forEach((button) => {
    if (button.classList.contains("speak-button")) {
      button.addEventListener("click", () => speakText(message.content));
    } else if (button.classList.contains("regen-button")) {
      button.addEventListener("click", regenerateResponse);
    } else if (button.classList.contains("copy-button")) {
      button.addEventListener("click", () => copyText(message.content, button));
    } else if (button.classList.contains("edit-button")) {
      button.addEventListener("click", () => startEditingMessage(index));
    } else {
      button.addEventListener("click", () => giveFeedback(index, button.dataset.rating));
    }
  });
  node.querySelectorAll(".open-memory-note").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/obsidian/open/${encodeURIComponent(button.dataset.noteId)}`, { method: "POST", body: "{}" });
    } catch (error) { toast(error.message, "error"); }
  }));
  node.querySelectorAll(".agent-run-action").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.action;
    const runId = button.dataset.runId;
    try {
      if (action === "resume") {
        if (app.generating) return toast("Wait for the current response to stop before resuming.", "error");
        await streamAssistantResponse({ continuation: true, resumeRunId: runId });
        return;
      }
      const updated = await api(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", body: "{}" });
      message.agentRun = { ...message.agentRun, state: updated.state, budgets: updated.budgets };
      app.controller?.abort();
      renderMessages();
      toast(action === "pause" ? "Agent run paused." : "Agent run cancelled.");
    } catch (error) { toast(error.message, "error"); }
  }));
  node.querySelectorAll(".tool-run-decision").forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api(`/api/tool-runs/${encodeURIComponent(button.dataset.runId)}/decision`, {
        method: "POST", body: JSON.stringify({ decision: button.dataset.decision })
      });
      await Promise.all([refreshTools(), refreshObsidian()]);
      toast(button.dataset.decision === "approved" ? "Approved action completed." : "Action rejected; nothing was changed.");
      if (result.continuationAvailable && result.conversationId === app.conversationId && !app.generating) {
        await streamAssistantResponse({ continuation: true, ...(result.agentRunId ? { resumeRunId: result.agentRunId } : {}) });
      }
    } catch (error) { toast(error.message, "error"); }
  }));
  return node;
}

async function giveFeedback(index, rating) {
  const assistant = app.messages[index];
  if (!assistant) return;
  if (assistant.feedback === rating) {
    toast("This response already has that rating.");
    return;
  }
  const changingRating = Boolean(assistant.feedback);
  let note = "";
  if (rating === "down") {
    note = window.prompt("What should the assistant do differently? (optional)") || "";
  }
  const user = [...app.messages.slice(0, index)].reverse().find((message) => message.role === "user");
  try {
    await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        rating,
        note,
        messageId: assistant.id || null,
        conversationId: app.conversationId || null,
        userMessage: user?.content || "",
        assistantMessage: assistant.content,
        model: assistant.model
      })
    });
    assistant.feedback = rating;
    saveLocal();
    renderMessages();
    await refreshState();
    toast(changingRating ? "Rating updated." : rating === "up" ? "Helpful signal saved." : "Improvement signal saved.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function addMessage(message) {
  app.messages.push(message);
  saveLocal();
  renderMessages();
}

function renderAttachments() {
  if (!elements.attachmentStrip) return;
  elements.attachmentStrip.classList.toggle("hidden", !app.attachments.length);
  elements.attachmentStrip.innerHTML = app.attachments.map((attachment, index) => `
    <span class="attachment-chip">
      <img src="data:image/jpeg;base64,${attachment}" alt="Attached image ${index + 1}" />
      <button type="button" class="attachment-remove" data-index="${index}" aria-label="Remove image">×</button>
    </span>
  `).join("");
  elements.attachmentStrip.querySelectorAll(".attachment-remove").forEach((button) => {
    button.addEventListener("click", () => {
      app.attachments.splice(Number(button.dataset.index), 1);
      renderAttachments();
    });
  });
}

// Downscale to keep payloads small, and return raw base64 (no data: prefix) as Ollama expects.
async function encodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function addAttachments(files) {
  for (const file of files) {
    if (app.attachments.length >= 3) {
      toast("Up to three images per message.", "error");
      break;
    }
    if (!file.type.startsWith("image/")) continue;
    try {
      app.attachments.push(await encodeImageFile(file));
    } catch {
      toast(`Couldn't read ${file.name}.`, "error");
    }
  }
  renderAttachments();
}

// Composer commands are handled locally and never reach a model. `/agent` is
// the only entry point to the goal runner now that it has no sidebar tab.
const COMPOSER_COMMANDS = [
  { name: "/agent", description: "Plan and run a verified goal", run: openAgentGoal },
  { name: "/sandbox", description: "Review simulations before they touch the project", run: openSandbox },
  { name: "/physics", description: "Open the physics sandbox", run: () => switchView("physics") },
  { name: "/lab", description: "Open the lab display", run: () => switchView("lab") },
  { name: "/demo", description: "Watch Evolv run a narrated experiment", run: () => switchView("demo") }
];

function openSandbox() {
  switchView("sandbox");
}

// A response is worth more outside Evolv than inside it. Code blocks already
// had this; whole messages did not, which left selecting the text by hand.
// The old way of copying, which needs no permission and no secure context.
// navigator.clipboard does not exist at all outside a secure context, and Evolv
// is a plain-HTTP local server: open it from another machine on the network and
// the modern API is simply absent.
function copyBySelection(value) {
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:-1000px;opacity:0;";
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function copyText(text, button, { label = "" } = {}) {
  const value = String(text || "");
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch {
    // Chromium asks permission for this and the desktop app answers narrowly,
    // so a refusal here is expected rather than exceptional. Fall through.
    copied = false;
  }
  if (!copied) copied = copyBySelection(value);
  if (!copied) return toast("Clipboard is unavailable.", "error");
  if (button) {
    const original = button.textContent;
    button.textContent = button.dataset.copiedLabel || "✓";
    setTimeout(() => { button.textContent = original; }, 1200);
  }
  if (label) toast(label);
  return true;
}

// The slash commands existed but could only be reached by typing one from
// memory. The menu appears as soon as a "/" is typed and lists what is there.
function renderCommandMenu() {
  const match = elements.prompt.value.match(/^\/([a-z0-9-]*)$/i);
  const matches = match
    ? COMPOSER_COMMANDS.filter((command) => command.name.slice(1).startsWith(match[1].toLowerCase()))
    : [];
  elements.commandMenu.classList.toggle("hidden", !matches.length);
  if (!matches.length) return;
  elements.commandMenu.innerHTML = matches.map((command) => `
    <button type="button" data-command="${escapeHtml(command.name)}">
      <strong>${escapeHtml(command.name)}</strong><span>${escapeHtml(command.description)}</span>
    </button>`).join("");
}

function hideCommandMenu() {
  elements.commandMenu?.classList.add("hidden");
}

// Editing loads the message back into the composer and marks the point the
// conversation will be rewound to. Nothing is deleted until the edited message
// is actually sent, so backing out costs nothing.
function startEditingMessage(index) {
  const message = app.messages[index];
  if (!message || message.role !== "user" || app.generating) return;
  app.editing = { id: message.id, index };
  elements.prompt.value = message.content || "";
  elements.editBanner.classList.remove("hidden");
  resizePrompt();
  elements.prompt.focus();
  elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length);
}

function cancelEditing() {
  if (!app.editing) return false;
  app.editing = null;
  elements.prompt.value = "";
  elements.editBanner.classList.add("hidden");
  resizePrompt();
  return true;
}

async function saveChatToVault() {
  if (!app.conversationId || !app.messages.length) {
    toast("There is no chat to save yet.", "error");
    return;
  }
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(app.conversationId)}/vault-note`, {
      method: "POST",
      body: "{}"
    });
    toast(`Saved to ${result.path}`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function matchComposerCommand(text) {
  const match = String(text).trim().match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = COMPOSER_COMMANDS.find((item) => item.name === `/${match[1].toLowerCase()}`);
  return command ? { command, argument: (match[2] || "").trim() } : null;
}

function openAgentGoal(objective = "") {
  switchView("agent");
  const form = $("#agent-goal-form");
  const field = form?.elements?.objective;
  if (!field) return;
  if (objective) field.value = objective;
  // Send the person to the first thing they still have to supply.
  const next = objective ? (form.elements.successCriteria?.value.trim() ? form : form.elements.successCriteria) : field;
  (next === form ? form.elements.objective : next).focus();
  if (objective) toast("Goal drafted. Add success criteria, then propose a plan.");
}

async function sendMessage(text) {
  if (!text.trim() || app.generating) return;
  hideCommandMenu();

  // An edited question replaces itself and the replies it drew. The rewind
  // happens first and only once: if it fails, nothing is sent and the
  // conversation is exactly as it was.
  if (app.editing) {
    const { id } = app.editing;
    try {
      await api(`/api/conversations/${encodeURIComponent(app.conversationId)}/truncate`, {
        method: "POST",
        body: JSON.stringify({ messageId: id })
      });
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    app.editing = null;
    elements.editBanner.classList.add("hidden");
    await openConversation(app.conversationId);
  }

  const composerCommand = matchComposerCommand(text);
  if (composerCommand) {
    elements.prompt.value = "";
    resizePrompt();
    composerCommand.command.run(composerCommand.argument);
    return;
  }
  if (!elements.model.value) {
    toast("Install or select an Ollama model first.", "error");
    return;
  }
  if (!app.conversationId) {
    const conversation = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "New conversation" })
    });
    app.conversationId = conversation.id;
    saveLocal();
  }
  const images = app.attachments.slice(0, 3);
  const packCommandId = app.pendingPackCommand?.id || "";
  const packId = app.activePack?.id || "";
  app.attachments = [];
  clearPackCommand();
  renderAttachments();
  addMessage({ role: "user", content: text.trim(), ...(images.length ? { images } : {}) });
  elements.prompt.value = "";
  resizePrompt();
  await streamAssistantResponse({ text: text.trim(), ...(images.length ? { images } : {}), ...(packCommandId ? { packCommandId } : packId ? { packId } : {}) });
}

async function regenerateResponse() {
  if (app.generating) return;
  if (!elements.model.value) {
    toast("Install or select an Ollama model first.", "error");
    return;
  }
  if (!app.conversationId || !app.messages.some((message) => message.role === "user")) {
    toast("Nothing to regenerate yet.", "error");
    return;
  }
  await streamAssistantResponse({ regenerate: true });
}

// Shared streaming path for new messages and regenerations. `request` carries
// either { text, images? } or { regenerate: true }.
async function streamAssistantResponse(request) {
  const assistant = {
    role: "assistant",
    content: "",
    thinking: "",
    model: elements.model.value,
    mode: app.settings.mode,
    knowledge: [],
    memory: [],
    routing: null,
    tools: [],
    notices: [],
    streaming: true
  };
  addMessage(assistant);
  setGenerating(true);
  app.controller = new AbortController();

  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(app.conversationId)}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-evolv-csrf": app.auth.csrfToken
      },
      body: JSON.stringify({
        ...request,
        ...(app.activeProjectId ? { projectId: app.activeProjectId } : {}),
        provider: app.settings.provider,
        model: elements.model.value,
        think: parseThink(elements.think.value),
        mode: app.settings.mode,
        temperature: Number(elements.temperature.value),
        numCtx: Number(elements.contextSize.value),
        maxTokens: Number(elements.maxTokens.value) || 4096
      }),
      signal: app.controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 && payload.code === "AUTH_REQUIRED") {
        window.location.replace("/login.html");
        throw new Error("Evolv is locked.");
      }
      const error = new Error(payload.error || `Chat failed (${response.status})`);
      error.code = payload.code || "CHAT_ERROR";
      error.status = response.status;
      throw error;
    }
    await consumeNdjson(response, (event) => {
      if (event.type === "run") {
        assistant.agentRun = {
          id: event.runId,
          stepId: event.stepId,
          state: event.state,
          budgets: event.budgets || null
        };
      } else if (event.type === "routing") {
        assistant.model = event.model || assistant.model;
        assistant.provider = event.provider || "";
        assistant.routing = event;
        if (event.fallback?.used) assistant.notices.push(event.fallback.message || "A model fallback was used.");
      } else if (event.type === "metadata") {
        assistant.mode = event.mode;
        assistant.knowledge = event.knowledge || [];
        assistant.memory = event.memory || [];
        assistant.vault = event.vault || null;
        assistant.project = event.project || null;
        if (event.project?.knowledgeWithheld) assistant.notices.push("Project knowledge was withheld from this cloud provider.");
        if (event.pack) assistant.notices.push(`${event.pack.name} command: ${event.pack.command}`);
        if (event.toolsUnsupported && elements.toolsMaster?.checked && app.tools.some((tool) => tool.enabled)) {
          assistant.notices.push("This model doesn't support tools; answering without them.");
        }
      } else if (event.type === "reasoning") {
        assistant.thinking += event.delta || "";
      } else if (event.type === "content") {
        assistant.id = event.messageId || assistant.id;
        assistant.content += event.delta || "";
      } else if (event.type === "tool_request") {
        assistant.tools.push({
          callId: event.callId,
          name: event.tool,
          arguments: event.arguments,
          status: "running"
        });
      } else if (event.type === "tool_result") {
        const activity = assistant.tools.find((tool) => tool.callId === event.callId);
        if (activity) Object.assign(activity, {
          status: event.cached ? "cached" : event.status,
          output: event.output,
          durationMs: event.durationMs,
          runId: event.runId || null,
          pendingApproval: event.status === "approval_required"
        });
      } else if (event.type === "error" && event.code !== "INTERRUPTED") {
        if (event.code === "PROVIDER_AUTH_FAILED") {
          assistant.notices.push("The provider rejected its saved API key. Replace it in Settings; your Evolv account is still signed in.");
          refreshProviders().catch(() => {});
          assistant.content ||= `I couldn't complete that response.\n\n${event.error}`;
        } else if (event.code === "TOOL_LOOP_LIMIT") {
          assistant.notices.push("Tool-call limit reached — this answer may be incomplete.");
        } else if (/stopped responding/i.test(event.error || "")) {
          assistant.notices.push("The model stopped responding and the request was cancelled.");
          assistant.content ||= "";
        } else {
          assistant.content ||= `I couldn't complete that response.\n\n${event.error}`;
        }
      } else if (event.type === "complete") {
        assistant.id = event.messageId || assistant.id;
        assistant.status = event.status;
      }
      if (["run", "routing", "tool_request", "tool_result", "metadata", "error"].includes(event.type)) renderMessages();
      else updateStreamingMessage(assistant);
    });
    if (app.settings.autoSpeak) {
      speakText(assistant.content);
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      assistant.content ||= `I couldn't complete that response.\n\n${error.message}`;
      toast(error.message, "error");
    }
  } finally {
    assistant.streaming = false;
    saveLocal();
    renderMessages();
    setGenerating(false);
    refreshConversations().catch(() => {});
    refreshTools().catch(() => {});
    refreshMacros().catch(() => {});
    refreshIntelligence().catch(() => {});
  }
}

async function consumeNdjson(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onChunk(JSON.parse(line));
      } catch {
        console.warn("Skipped a malformed stream line.");
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    try {
      onChunk(JSON.parse(buffer));
    } catch {
      console.warn("Skipped a malformed stream line.");
    }
  }
}

function updateStreamingMessage(assistant) {
  const index = app.messages.indexOf(assistant);
  const current = elements.messages.querySelector(`[data-index="${index}"]`);
  if (!current) return renderMessages();
  const content = current.querySelector(".message-content");
  content.innerHTML = `${renderMarkdown(assistant.content)}<span class="typing-cursor"></span>`;
  const thinking = current.querySelector(".thinking");
  if (assistant.thinking) {
    thinking.classList.remove("hidden");
    thinking.querySelector(".thinking-text").textContent = assistant.thinking;
  }
  scrollBottom();
}

function parseThink(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function setGenerating(value) {
  app.generating = value;
  elements.send.disabled = value;
  elements.stop.classList.toggle("hidden", !value);
  elements.send.classList.toggle("hidden", value);
}

function scrollBottom() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
}

function marketplaceQuery() {
  const params = new URLSearchParams({
    query: $("#marketplace-search")?.value.trim() || "",
    category: $("#marketplace-category")?.value || "",
    filter: app.marketplaceTab === "installed" ? "installed" : ($("#marketplace-filter")?.value || ""),
    sort: $("#marketplace-sort")?.value || "featured",
    os: $("#marketplace-os")?.value || "",
    model: $("#marketplace-model-filter")?.value.trim() || ""
  });
  return params.toString();
}

function marketplaceArtwork(pack) {
  const candidate = (pack.screenshots || []).find((item) =>
    /^\/assets\/marketplace\/[a-z0-9-]+\.(?:jpg|png)$/.test(String(item || "")));
  return candidate || "";
}

async function refreshMarketplace({ preserveDetails = true } = {}) {
  if (!$("#marketplace-view")) return;
  $("#marketplace-status").textContent = "Refreshing local catalog…";
  try {
    app.marketplace = await api(`/api/marketplace?${marketplaceQuery()}`);
    if (app.marketplace.developerMode) {
      try { app.marketplacePublishers = (await api("/api/marketplace/publishers")).publishers || []; } catch { app.marketplacePublishers = []; }
    }
    $("#marketplace-developer-mode").checked = Boolean(app.marketplace.developerMode);
    $("#marketplace-developer-mode-settings").checked = Boolean(app.marketplace.developerMode);
    $("#marketplace-developer-panel").classList.toggle("hidden", !app.marketplace.developerMode);
    const remote = app.marketplace.remoteCatalog || {};
    if (document.activeElement !== $("#marketplace-catalog-url")) $("#marketplace-catalog-url").value = remote.url || "";
    $("#marketplace-catalog-status").textContent = remote.configured
      ? `${remote.cached ? "Verified cache ready" : "Configured, not cached"}${remote.fetchedAt ? ` · synced ${new Date(remote.fetchedAt).toLocaleString()}` : ""}${remote.lastError ? ` · ${remote.lastError}` : ""}`
      : "No remote catalog configured. Only trusted Ed25519 publisher keys are accepted.";
    const reviewBackend = app.marketplace.reviewBackend || {};
    if (document.activeElement !== $("#marketplace-review-url")) $("#marketplace-review-url").value = reviewBackend.url || "";
    $("#marketplace-review-key").innerHTML = `<option value="">Choose a trusted publisher key</option>${(app.marketplacePublishers || [])
      .filter((publisher) => publisher.trusted)
      .map((publisher) => `<option value="${escapeHtml(publisher.keyId)}" ${publisher.keyId === reviewBackend.publisherKeyId ? "selected" : ""}>${escapeHtml(publisher.name)} · ${escapeHtml(publisher.keyId.slice(-12))}</option>`).join("")}`;
    $("#marketplace-review-status").textContent = reviewBackend.configured
      ? `Signed responses pinned to ${reviewBackend.publisherKeyId}.`
      : "No review service configured. Reviews remain in the local outbox.";
    const updates = (app.marketplace.installed || []).filter((item) => item.updateAvailable).length;
    $("#marketplace-dot").classList.toggle("hidden", updates === 0);
    renderMarketplace();
    if (preserveDetails && app.marketplaceSelectedId) await openMarketplaceDetails(app.marketplaceSelectedId, { quiet: true });
  } catch (error) {
    $("#marketplace-status").textContent = `Marketplace unavailable: ${error.message}`;
    $("#marketplace-grid").innerHTML = "";
    throw error;
  }
}

function renderMarketplaceCard(pack) {
  const state = pack.updateAvailable ? "Update available" : pack.installed ? (pack.enabled ? "Installed" : "Disabled") : pack.price ? `$${pack.price.toFixed(2)}` : "Free";
  const artwork = marketplaceArtwork(pack);
  return `
    <article class="marketplace-card ${pack.id === app.marketplaceSelectedId ? "selected" : ""}" tabindex="0" role="button" data-pack-id="${escapeHtml(pack.id)}" aria-label="Open ${escapeHtml(pack.name)}" aria-current="${pack.id === app.marketplaceSelectedId ? "true" : "false"}">
      ${artwork ? `<img class="marketplace-card-art" src="${escapeHtml(artwork)}" alt="" loading="lazy" decoding="async" />` : ""}
      <div class="marketplace-card-head">
        <div class="marketplace-icon"><span>${escapeHtml(pack.icon)}</span></div>
        <div><h3>${escapeHtml(pack.name)}</h3><div class="marketplace-card-meta"><span>${escapeHtml(pack.author.name)}</span><span>v${escapeHtml(pack.version)}</span></div></div>
        ${pack.verified ? '<span class="marketplace-badge good">Verified</span>' : ""}
      </div>
      <p>${escapeHtml(pack.description)}</p>
      <div class="marketplace-badges">
        <span class="marketplace-badge">${escapeHtml(pack.category.replaceAll("-", " "))}</span>
        <span class="marketplace-badge ${pack.updateAvailable ? "warn" : pack.installed ? "good" : ""}">${escapeHtml(state)}</span>
        ${pack.localOnly ? '<span class="marketplace-badge">Local-only</span>' : '<span class="marketplace-badge warn">Cloud optional</span>'}
      </div>
      <div class="marketplace-card-meta"><span>★ ${pack.rating.toFixed(1)}</span><span>${pack.reviewCount} catalog reviews</span><span>${pack.commands.length} commands</span></div>
    </article>`;
}

function renderMarketplace() {
  if (!app.marketplace) return;
  $$(".marketplace-tab").forEach((button) => {
    const active = button.dataset.marketplaceTab === app.marketplaceTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const commandsMode = app.marketplaceTab === "commands";
  const packs = app.marketplace.packs || [];
  $("#marketplace-featured").classList.toggle("hidden", true);
  $("#marketplace-grid").innerHTML = commandsMode
    ? renderMarketplaceCommands(app.marketplace.runtime || [])
    : packs.map(renderMarketplaceCard).join("");
  $("#marketplace-empty").classList.toggle("hidden", commandsMode ? (app.marketplace.runtime || []).some((item) => item.type === "command") : packs.length > 0);
  $("#marketplace-status").textContent = commandsMode
    ? `${(app.marketplace.runtime || []).filter((item) => item.type === "command").length} enabled pack commands · local registry`
    : `${packs.length} bundled pack${packs.length === 1 ? "" : "s"} · ${app.marketplace.installed.length} installed · available offline`;
}

function renderMarketplaceCommands(runtime) {
  const commands = runtime.filter((item) => item.type === "command");
  const packs = [...new Map(commands.map((command) => [command.packId, command])).values()];
  return packs.map((command) => `
    <article class="marketplace-command-card">
      <div class="marketplace-card-meta"><span>${escapeHtml(command.packName)}</span><span>Free-form specialist</span></div>
      <h3>Chat with ${escapeHtml(command.packName)}</h3>
      <p>Describe what you need in your own words. The pack will infer and formulate the task instead of requiring a preset command.</p>
      <button class="primary-button marketplace-chat-pack" type="button" data-pack-id="${escapeHtml(command.packId)}" data-pack-name="${escapeHtml(command.packName)}">Enter chat</button>
    </article>`).join("");
}

function permissionMarkup(permission, { selectable = false, granted = [] } = {}) {
  const checked = permission.required || granted.includes(permission.id);
  return `<label class="marketplace-permission">
    ${selectable ? `<input type="checkbox" value="${escapeHtml(permission.id)}" ${checked ? "checked" : ""} ${permission.required ? "disabled" : ""} />` : "<span></span>"}
    <span><strong>${escapeHtml(permission.name || permission.id)} ${permission.required ? "· required" : "· optional"}</strong>
      <small>${escapeHtml(permission.description || "")}</small><small>Why: ${escapeHtml(permission.reason || "")}</small>
      ${permission.supported === false ? '<small>This permission is modeled but not implemented in the v0.1 runtime.</small>' : ""}
    </span>
    <span class="marketplace-risk">${escapeHtml(permission.risk || "")}</span>
  </label>`;
}

async function openMarketplaceDetails(id, { quiet = false } = {}) {
  try {
    const pack = await api(`/api/marketplace/packs/${encodeURIComponent(id)}`);
    const artwork = marketplaceArtwork(pack);
    app.marketplaceSelectedId = id;
    const installed = pack.installedRecord;
    let reviewState = { backend: app.marketplace?.reviewBackend || {}, trustedReviews: [], outbox: [], fetchedAt: null };
    if (installed) {
      try { reviewState = await api(`/api/marketplace/packs/${encodeURIComponent(id)}/reviews`); } catch {}
    }
    const devWatch = (app.marketplace?.developerWatches || []).find((item) => item.id === pack.id);
    const primary = !installed
      ? `<button class="primary-button marketplace-install" type="button" data-pack-id="${escapeHtml(pack.id)}">Install</button>`
      : pack.updateAvailable
        ? `<button class="primary-button marketplace-update" type="button" data-pack-id="${escapeHtml(pack.id)}" data-version="${escapeHtml(pack.availableVersion || "")}">Review ${escapeHtml(pack.availableVersion || "update")}</button>`
        : `<button class="secondary-button marketplace-toggle" type="button" data-pack-id="${escapeHtml(pack.id)}" data-enabled="${String(!installed.enabled)}">${installed.enabled ? "Disable" : "Enable"}</button>`;
    const chatAction = installed?.enabled
      ? `<button class="primary-button marketplace-chat-pack" type="button" data-pack-id="${escapeHtml(pack.id)}" data-pack-name="${escapeHtml(pack.name)}" data-pack-artwork="${escapeHtml(artwork)}">Chat with this pack</button>`
      : "";
    $("#marketplace-details").innerHTML = `
      <div class="marketplace-detail-head">
        <div class="marketplace-icon"><span>${escapeHtml(pack.icon)}</span></div>
        <div><p class="eyebrow">${pack.verified ? "VERIFIED CREATOR" : "LOCAL DEVELOPER"}</p><h2>${escapeHtml(pack.name)}</h2>
          <div class="marketplace-card-meta"><span>${escapeHtml(pack.author.name)}</span><span>v${escapeHtml(pack.version)}</span><span>${escapeHtml(pack.license)}</span></div>
        </div>
      </div>
      <p>${escapeHtml(pack.fullDescription)}</p>
      ${artwork
        ? `<figure class="marketplace-preview"><img src="${escapeHtml(artwork)}" alt="${escapeHtml(`${pack.name} cover artwork`)}" decoding="async" /></figure>`
        : `<div class="marketplace-preview marketplace-preview-empty" aria-label="No pack artwork available"><span>${escapeHtml(pack.name)}<br><small>No artwork included</small></span></div>`}
      <div class="marketplace-actions">${chatAction}${primary}
        ${installed ? `<button class="secondary-button marketplace-configure" type="button" data-pack-id="${escapeHtml(pack.id)}">Configure</button>
          <button class="secondary-button marketplace-export" type="button" data-pack-id="${escapeHtml(pack.id)}">Export</button>` : ""}
      </div>
      ${installed ? `<label class="marketplace-channel">Update channel
        <select class="marketplace-channel-select" data-pack-id="${escapeHtml(pack.id)}" aria-label="Update channel for ${escapeHtml(pack.name)}">
          ${["stable", "beta", "nightly"].map((channel) => `<option value="${channel}" ${installed.releaseChannel === channel ? "selected" : ""}>${channel[0].toUpperCase()}${channel.slice(1)}</option>`).join("")}
        </select>
        <small>${pack.updateAvailable ? `${escapeHtml(pack.availableVersion)} is available.` : "This channel is up to date."}</small>
      </label>` : ""}
      ${installed && app.marketplace?.developerMode ? `<div class="marketplace-actions">
        ${devWatch
          ? `<button class="secondary-button marketplace-dev-watch-stop" type="button" data-pack-id="${escapeHtml(pack.id)}">Stop live reload</button>
             <span class="settings-note">${escapeHtml(devWatch.status)} · ${escapeHtml(devWatch.sourceName)}${devWatch.error ? ` · ${escapeHtml(devWatch.error)}` : ""}</span>`
          : `<button class="secondary-button marketplace-dev-watch-start" type="button" data-pack-id="${escapeHtml(pack.id)}">Watch source folder</button>`}
      </div>` : ""}
      <div class="marketplace-badges">
        <span class="marketplace-badge ${pack.verified ? "good" : pack.publisherVerification?.valid ? "warn" : ""}">${pack.verified ? "Verified publisher" : pack.publisherVerification?.valid ? "Signed · publisher not trusted" : "Unsigned"}</span>
        <span class="marketplace-badge">${escapeHtml(pack.platforms.join(" · "))}</span>
        <span class="marketplace-badge">${Math.ceil(pack.installedSize / 1024)} KB</span>
      </div>
      <section class="marketplace-detail-section"><h3>Features</h3><ul>${pack.features.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
      <section class="marketplace-detail-section"><h3>Commands</h3>${pack.commands.map((command) => `
        <div class="marketplace-command-card"><strong>${escapeHtml(command.name)}</strong><p>${escapeHtml(command.description)}</p></div>`).join("")}</section>
      <section class="marketplace-detail-section"><h3>Example tasks</h3><ul>${pack.examples.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
      <section class="marketplace-detail-section"><h3>Permissions</h3>${pack.permissions.map((permission) => `
        ${permissionMarkup(permission)}
        ${installed?.grantedPermissions?.includes(permission.id) ? `<button class="secondary-button marketplace-revoke" type="button" data-pack-id="${escapeHtml(pack.id)}" data-permission="${escapeHtml(permission.id)}">Revoke ${escapeHtml(permission.required ? "required permission · disables pack" : "optional permission")}</button>` : ""}
      `).join("")}</section>
      ${(pack.dependencies?.length || pack.conflicts?.length) ? `<section class="marketplace-detail-section"><h3>Pack relationships</h3>
        ${(pack.dependencies || []).map((item) => `<p><strong>Requires</strong> ${escapeHtml(item.id)} ${escapeHtml(item.range)}${item.optional ? " · optional" : ""}</p>`).join("")}
        ${(pack.conflicts || []).map((item) => `<p><strong>Conflicts</strong> ${escapeHtml(item.id)} ${escapeHtml(item.range)} · ${escapeHtml(item.reason)}</p>`).join("")}
      </section>` : ""}
      <section class="marketplace-detail-section"><h3>Compatibility</h3><p>Requires Evolv ${escapeHtml(pack.minEvolvVersion)}+ · Local: ${escapeHtml(pack.models.local.join(", "))} · Cloud: ${escapeHtml(pack.models.cloud.join(", "))}</p></section>
      <details class="marketplace-detail-section"><summary>Documentation</summary><div>${renderMarkdown(pack.documentation)}</div></details>
      <details class="marketplace-detail-section"><summary>Changelog</summary><ul>${pack.changelog.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>
      ${installed ? `<section class="marketplace-detail-section marketplace-reviews"><h3>Reviews</h3>
        <p class="settings-note">${reviewState.backend?.configured
          ? `Only reviews carrying the configured backend's valid signature are shown as published.${reviewState.fetchedAt ? ` Last checked ${escapeHtml(new Date(reviewState.fetchedAt).toLocaleString())}.` : ""}`
          : "No trusted review service is configured. Submissions are stored locally and are not presented as published."}</p>
        ${reviewState.backend?.configured ? `<button class="secondary-button marketplace-review-sync" type="button" data-pack-id="${escapeHtml(pack.id)}">Refresh signed reviews</button>` : ""}
        <div class="marketplace-review-list">${(reviewState.trustedReviews || []).map((review) => `<article class="marketplace-command-card">
          <div class="marketplace-card-meta"><span>${"★".repeat(review.rating)}</span><span>${escapeHtml(review.author)}</span><span>${escapeHtml(review.createdAt)}</span></div>
          <strong>${escapeHtml(review.title)}</strong><p>${escapeHtml(review.body)}</p>
        </article>`).join("") || '<p class="settings-note">No verified published reviews are cached.</p>'}</div>
        ${(reviewState.outbox || []).length ? `<details><summary>Local review outbox · ${reviewState.outbox.length}</summary>${reviewState.outbox.map((review) => `<p><strong>${escapeHtml(review.title)}</strong> · ${escapeHtml(review.status)}${review.lastError ? ` · ${escapeHtml(review.lastError)}` : ""}</p>`).join("")}</details>` : ""}
        <form class="marketplace-review-form" data-pack-id="${escapeHtml(pack.id)}">
          <label>Rating <select name="rating" required><option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Okay</option><option value="2">2 · Needs work</option><option value="1">1 · Poor</option></select></label>
          <label>Title <input name="title" maxlength="160" required /></label>
          <label>Details <textarea name="body" minlength="10" maxlength="4000" rows="3" required></textarea></label>
          <button class="secondary-button" type="submit">Save review${reviewState.backend?.configured ? " & send" : " to local outbox"}</button>
        </form>
      </section>` : ""}
      <details class="marketplace-detail-section"><summary>Raw manifest</summary><pre class="marketplace-diagnostics">${escapeHtml(JSON.stringify({
        schemaVersion: pack.schemaVersion, id: pack.id, name: pack.name, version: pack.version, author: pack.author,
        category: pack.category, license: pack.license, minEvolvVersion: pack.minEvolvVersion, platforms: pack.platforms,
        models: pack.models, permissions: pack.permissions.map(({ id, required, reason }) => ({ id, required, reason })),
        configSchema: pack.configSchema, agents: pack.agents, commands: pack.commands, workflows: pack.workflows
      }, null, 2))}</pre></details>
      ${installed ? `<details class="marketplace-detail-section"><summary>Diagnostics</summary><pre class="marketplace-diagnostics">${escapeHtml(JSON.stringify(pack.diagnostics, null, 2))}</pre>
        <div class="marketplace-actions"><button class="secondary-button marketplace-copy-diagnostics" type="button">Copy diagnostics</button>
        <button class="secondary-button marketplace-export-diagnostics" type="button" data-pack-id="${escapeHtml(pack.id)}">Export diagnostics</button>
        <button class="secondary-button marketplace-repair" type="button" data-pack-id="${escapeHtml(pack.id)}">Reload & repair</button>
        ${pack.diagnostics?.canOpenDirectory ? `<button class="secondary-button marketplace-open-directory" type="button" data-pack-id="${escapeHtml(pack.id)}">Open pack directory</button>` : ""}</div></details>
        <div class="marketplace-actions"><button class="secondary-button marketplace-uninstall" type="button" data-pack-id="${escapeHtml(pack.id)}">Uninstall</button>
        <button class="secondary-button" type="button" disabled title="Available with a future remote catalog">Report · remote catalog only</button></div>` : ""}
    `;
    // Pack details are replaced every time a card is selected. Bind the main
    // install/update action to the new button itself so it does not depend on
    // delegated-dialog behavior in Electron's packaged renderer.
    $("#marketplace-details").querySelector(".marketplace-install, .marketplace-update")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      if (button.disabled || app.marketplaceInstallInFlight) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await beginMarketplaceInstall({ id: button.dataset.packId, ...(button.dataset.version ? { version: button.dataset.version } : {}) });
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
    renderMarketplace();
  } catch (error) {
    if (!quiet) toast(error.message, "error");
  }
}

async function beginMarketplaceInstall(input) {
  if (app.marketplaceInstallInFlight) return;
  const preview = await api("/api/marketplace/install/preview", { method: "POST", body: JSON.stringify(input) });
  app.pendingMarketplaceInstall = { ...input, preview };
  const error = $("#marketplace-permission-error");
  error.textContent = "";
  error.classList.add("hidden");
  $("#marketplace-permission-title").textContent = `${preview.action === "update" ? "Update" : "Install"} ${preview.manifest.name}`;
  $("#marketplace-permission-summary").textContent = preview.previousVersion
    ? `Update ${preview.previousVersion} → ${preview.manifest.version}. Review every permission before continuing.`
    : `Install ${preview.manifest.version} from the ${input.package ? "local file" : "bundled offline"} catalog.`;
  const previouslyGranted = preview.grantedPermissions || [];
  const relationships = preview.relationships || { dependencies: [], conflicts: [] };
  const relationshipReview = $("#marketplace-relationship-review");
  const relationshipRows = [
    ...relationships.dependencies.map((item) => `<div class="marketplace-permission"><span aria-hidden="true">${item.installed && item.enabled && item.satisfies ? "✓" : item.optional ? "○" : "!"}</span><span><strong>${item.optional ? "Optional" : "Requires"} ${escapeHtml(item.id)} ${escapeHtml(item.range)}</strong><small>${item.installed ? `Installed ${escapeHtml(item.version)} · ${item.enabled ? "enabled" : "disabled"} · ${item.satisfies ? "compatible" : "incompatible"}` : "Not installed"}</small></span></div>`),
    ...relationships.conflicts.map((item) => `<div class="marketplace-permission"><span aria-hidden="true">${item.installed && item.enabled && item.satisfies ? "!" : "✓"}</span><span><strong>Conflicts with ${escapeHtml(item.id)} ${escapeHtml(item.range)}</strong><small>${escapeHtml(item.reason)} · ${item.installed ? `${item.enabled ? "enabled" : "disabled"} ${escapeHtml(item.version)}` : "not installed"}</small></span></div>`)
  ];
  relationshipReview.classList.toggle("hidden", relationshipRows.length === 0);
  relationshipReview.innerHTML = relationshipRows.join("");
  const publisherReview = $("#marketplace-publisher-review");
  const verification = preview.verification || {};
  if (verification.state === "signed") {
    publisherReview.classList.remove("hidden");
    publisherReview.innerHTML = `<label class="marketplace-permission">
      <input id="marketplace-trust-publisher" type="checkbox" />
      <span><strong>Trust ${escapeHtml(verification.publisher?.name || "this publisher")}</strong>
      <small>Valid Ed25519 signature · fingerprint ${escapeHtml(verification.keyId || "")}. Trusting this identity marks this and future correctly signed packs as verified.</small></span>
      <span class="marketplace-risk">publisher trust</span>
    </label>`;
  } else {
    publisherReview.classList.add("hidden");
    publisherReview.replaceChildren();
  }
  $("#marketplace-permission-list").innerHTML = preview.permissions.map((permission) =>
    permissionMarkup(permission, { selectable: true, granted: previouslyGranted })).join("");
  $("#marketplace-permission-confirm").textContent = preview.action === "update" ? "Approve & update" : "Approve & install";
  // Populate the approval card before placing it in Chromium's modal layer.
  // Opening an empty dialog first can lose the first click in a busy packaged
  // renderer, which made Install appear to do nothing.
  showMarketplaceDialog("permissions");
}

async function confirmMarketplaceInstall(event) {
  event.preventDefault();
  const pending = app.pendingMarketplaceInstall;
  if (!pending || app.marketplaceInstallInFlight) return;
  const approvedPermissions = [...$("#marketplace-permission-list").querySelectorAll('input[type="checkbox"]')]
    .filter((input) => input.checked || input.disabled).map((input) => input.value);
  const trustPublisher = Boolean($("#marketplace-trust-publisher")?.checked);
  const button = $("#marketplace-permission-confirm");
  app.marketplaceInstallInFlight = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = pending.preview.action === "update" ? "Updating…" : "Installing…";
  try {
    const request = {
      ...(pending.id ? { id: pending.id } : {}),
      ...(pending.version ? { version: pending.version } : {}),
      ...(pending.package ? { package: pending.package } : {}),
      approvedPermissions,
      trustPublisher
    };
    const installed = await api("/api/marketplace/install", {
      method: "POST",
      body: JSON.stringify(request)
    });
    const verified = await api(`/api/marketplace/packs/${encodeURIComponent(installed.id)}`);
    if (!verified.installedRecord || verified.installedRecord.version !== installed.version || !verified.installedRecord.enabled) {
      throw new Error("The pack was written but could not be verified as enabled. Open diagnostics and try Repair.");
    }
    closeMarketplaceDialog("permissions");
    app.pendingMarketplaceInstall = null;
    app.marketplaceSelectedId = installed.id;
    toast(`${installed.manifest.name} ${installed.version} installed and enabled.`);
    await refreshMarketplace();
    // A throttled renderer can deliver the dialog's first animation frame
    // after the install request finishes. Close once more after rendering so
    // that delayed focus work cannot leave the approval panel onscreen.
    closeMarketplaceDialog("permissions");
  } catch (error) {
    const output = $("#marketplace-permission-error");
    output.textContent = error.message;
    output.classList.remove("hidden");
    toast(error.message, "error");
  } finally {
    app.marketplaceInstallInFlight = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Approve & install";
  }
}

function configurationField(key, definition, value) {
  const id = `marketplace-config-${key}`;
  const title = escapeHtml(definition.title || key);
  const description = escapeHtml(definition.description || "");
  if (definition.type === "boolean") return `<label><span class="field-label">${title}</span><input id="${id}" name="${escapeHtml(key)}" type="checkbox" data-type="boolean" ${value ? "checked" : ""} /><small>${description}</small></label>`;
  if (definition.enum) return `<label><span class="field-label">${title}</span><select id="${id}" name="${escapeHtml(key)}" data-type="string">${definition.enum.map((item) => `<option ${item === value ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select><small>${description}</small></label>`;
  if (definition.type === "array") return `<label><span class="field-label">${title}</span><textarea id="${id}" name="${escapeHtml(key)}" data-type="array" rows="3">${escapeHtml((value || []).join("\n"))}</textarea><small>${description} One item per line.</small></label>`;
  if (definition.format === "model") {
    const options = (app.models || []).map((model) => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.providerName || model.provider || "")}</option>`).join("");
    return `<label><span class="field-label">${title}</span><input id="${id}" name="${escapeHtml(key)}" data-type="string" type="search" list="${id}-models" autocomplete="off" value="${escapeHtml(value ?? "")}" /><datalist id="${id}-models">${options}</datalist><small>${description} Search models currently available from the selected provider.</small></label>`;
  }
  if (["file", "folder"].includes(definition.format)) {
    return `<label><span class="field-label">${title}</span><span class="marketplace-picker-row">
      <input id="${id}" name="${escapeHtml(key)}" data-type="string" data-format="${escapeHtml(definition.format)}" type="text" readonly value="${escapeHtml(value ?? "")}" />
      <button class="secondary-button marketplace-config-picker" type="button" data-key="${escapeHtml(key)}">Choose ${escapeHtml(definition.format)}</button>
    </span><small>${description} The desktop dialog is required; the pack cannot choose a path itself.</small></label>`;
  }
  return `<label><span class="field-label">${title}</span><input id="${id}" name="${escapeHtml(key)}" data-type="${escapeHtml(definition.type)}" type="${definition.format === "secret" ? "password" : definition.type === "number" ? "number" : "text"}" value="${escapeHtml(value ?? "")}" /><small>${description}</small></label>`;
}

function marketplaceDialogByName(name) {
  const suffix = name === "permissions" ? "permission" : name;
  return $(`#marketplace-${suffix}-dialog`);
}

function marketplaceDialogs() {
  return ["permissions", "config", "starter"].map(marketplaceDialogByName).filter(Boolean);
}

function syncMarketplaceDialogBackdrop() {
  const open = marketplaceDialogs().some((dialog) => dialog.open || dialog.hasAttribute("open"));
  $("#marketplace-dialog-backdrop")?.classList.toggle("hidden", !open);
  document.documentElement.classList.toggle("marketplace-dialog-open", open);
}

function resetMarketplaceDialogs() {
  for (const dialog of marketplaceDialogs()) {
    try { if (dialog.open) dialog.close(); } catch {}
    dialog.removeAttribute("open");
    dialog.classList.remove("marketplace-dialog-visible");
    dialog.dataset.displayState = "closed";
  }
  app.marketplaceDialogReturnFocus = null;
  syncMarketplaceDialogBackdrop();
}

function showMarketplaceDialog(name) {
  const dialog = marketplaceDialogByName(name);
  if (!dialog) return;
  for (const other of marketplaceDialogs()) {
    if (other === dialog) continue;
    try { if (other.open) other.close(); } catch {}
    other.removeAttribute("open");
    other.classList.remove("marketplace-dialog-visible");
  }
  dialog.dataset.displayState = "opening";
  app.marketplaceDialogReturnFocus = document.activeElement;
  dialog.classList.add("marketplace-dialog-visible");
  dialog.setAttribute("aria-modal", "true");
  try {
    if (!dialog.open) dialog.show();
  } catch {
    dialog.setAttribute("open", "");
  }
  dialog.dataset.displayState = dialog.open ? "visible" : "visible-fallback";
  syncMarketplaceDialogBackdrop();
  requestAnimationFrame(() => {
    if (!dialog.open) return;
    dialog.dataset.displayState = "visible";
    const preferred = dialog.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    preferred?.focus();
  });
}

function closeMarketplaceDialog(name) {
  const dialog = marketplaceDialogByName(name);
  if (!dialog) return;
  dialog.classList.remove("marketplace-dialog-visible");
  dialog.removeAttribute("aria-modal");
  dialog.dataset.displayState = "closing";
  try { if (dialog.open) dialog.close(); } catch {}
  // Also clear the non-modal fallback used by older embedded Chromium builds.
  dialog.removeAttribute("open");
  dialog.dataset.displayState = "closed";
  syncMarketplaceDialogBackdrop();
  const target = app.marketplaceDialogReturnFocus;
  app.marketplaceDialogReturnFocus = null;
  if (target?.isConnected) target.focus();
}

async function openMarketplaceConfig(id) {
  const pack = await api(`/api/marketplace/packs/${encodeURIComponent(id)}`);
  if (!pack.installedRecord) return;
  const dialog = $("#marketplace-config-dialog");
  dialog.dataset.packId = id;
  dialog.dataset.dirty = "false";
  $("#marketplace-config-title").textContent = `Configure ${pack.name}`;
  $("#marketplace-config-fields").innerHTML = Object.entries(pack.configSchema.properties || {})
    .map(([key, definition]) => configurationField(key, definition, pack.installedRecord.config[key] ?? definition.default)).join("")
    || '<p class="settings-note">This pack has no configurable fields.</p>';
  $("#marketplace-config-error").classList.add("hidden");
  showMarketplaceDialog("config");
}

function collectMarketplaceConfig() {
  return Object.fromEntries([...$("#marketplace-config-fields").querySelectorAll("[name]")].map((input) => {
    const type = input.dataset.type;
    const value = type === "boolean" ? input.checked : type === "number" ? Number(input.value)
      : type === "array" ? input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : input.value;
    return [input.name, value];
  }));
}

function downloadJsonFile(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function activatePackCommand(button) {
  app.pendingPackCommand = {
    id: button.dataset.commandId,
    name: button.dataset.commandName,
    packName: button.dataset.packName
  };
  let badge = $("#pack-command-active");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "pack-command-active";
    badge.className = "pack-command-active";
    elements.prompt.parentElement.insertBefore(badge, elements.prompt);
  }
  badge.textContent = `${app.pendingPackCommand.packName} · ${app.pendingPackCommand.name} — type the task, then send`;
  switchView("chat");
  elements.prompt.placeholder = `Input for ${app.pendingPackCommand.name}…`;
  elements.prompt.focus();
}

async function activatePackChat(button) {
  const id = String(button.dataset.packId || "");
  const name = String(button.dataset.packName || "Specialist pack");
  const artwork = /^\/assets\/marketplace\/[a-z0-9-]+\.(?:jpg|png)$/.test(button.dataset.packArtwork || "")
    ? button.dataset.packArtwork : (id === "evolv.autonomous-engineer" ? "/assets/marketplace/autonomous-engineer.png" : "");
  app.pendingPackCommand = null;
  app.activePack = { id, name, artwork, mode: "free-form" };
  renderActivePack();
  await startNewChat({ preservePack: true, title: `${name} chat` });
  elements.prompt.placeholder = `Tell ${name} what you need…`;
  elements.prompt.focus();
  toast(`${name} is active. Describe the goal naturally; it will formulate the task.`);
}

function renderActivePack() {
  $("#pack-command-active")?.remove();
  if (!app.activePack) {
    elements.prompt.placeholder = "Message Evolv…";
    return;
  }
  const badge = document.createElement("div");
  badge.id = "pack-command-active";
  badge.className = "pack-command-active pack-chat-active";
  const artwork = app.activePack.artwork || (app.activePack.id === "evolv.autonomous-engineer" ? "/assets/marketplace/autonomous-engineer.png" : "");
  if (artwork) {
    const image = document.createElement("img");
    image.src = artwork;
    image.alt = "";
    badge.append(image);
  }
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = app.activePack.name;
  const note = document.createElement("small");
  note.textContent = "Free-form pack chat · task inferred from your message";
  copy.append(title, note);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pack-chat-exit";
  close.textContent = "Exit pack";
  close.addEventListener("click", clearActivePack);
  badge.append(copy, close);
  elements.prompt.parentElement.insertBefore(badge, elements.prompt);
  elements.prompt.placeholder = `Tell ${app.activePack.name} what you need…`;
}

function clearActivePack() {
  app.activePack = null;
  $("#pack-command-active")?.remove();
  elements.prompt.placeholder = "Message Evolv…";
}

function clearPackCommand() {
  app.pendingPackCommand = null;
  if (!app.activePack) {
    $("#pack-command-active")?.remove();
    elements.prompt.placeholder = "Message Evolv…";
  }
}

function activeProject() {
  return app.projects.find((project) => project.id === app.activeProjectId) || app.projects[0] || null;
}

function renderProjects() {
  if (!elements.projectSelect) return;
  elements.projectSelect.innerHTML = app.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
  const selected = activeProject();
  if (!selected) {
    elements.projectSelect.innerHTML = '<option value="">No projects</option>';
    return;
  }
  app.activeProjectId = selected.id;
  elements.projectSelect.value = selected.id;
  localStorage.setItem("evolv:active-project", selected.id);
  $("#project-detail-name").textContent = selected.name;
  $("#project-detail-description").textContent = selected.description || "No description yet.";
  $("#project-folder-status").textContent = selected.folderConnected ? `Connected · ${selected.folderLabel}` : "Folder not connected";
  $("#project-folder-status").classList.toggle("ready", selected.folderConnected);
  $("#project-counts").innerHTML = Object.entries(selected.counts || {}).map(([key, value]) =>
    `<span>${Number(value)} ${escapeHtml(key)}</span>`).join("");
}

async function refreshProjects() {
  const payload = await api("/api/projects");
  app.projects = payload.projects || [];
  if (!app.projects.some((project) => project.id === app.activeProjectId)) {
    app.activeProjectId = app.projects.find((project) => project.isDefault)?.id || app.projects[0]?.id || "";
  }
  renderProjects();
  const project = activeProject();
  if (!project) return;
  const [tasks, sources] = await Promise.all([
    api(`/api/projects/${encodeURIComponent(project.id)}/tasks`),
    api(`/api/projects/${encodeURIComponent(project.id)}/sources`)
  ]);
  $("#project-task-list").innerHTML = (tasks.tasks || []).map((task) => `
    <div class="project-list-item"><header><strong>${escapeHtml(task.title)}</strong><span class="status-pill">${escapeHtml(task.status)}</span></header>
    ${task.description ? `<small>${escapeHtml(task.description)}</small>` : ""}
    ${task.status !== "done" ? `<button class="secondary-button project-task-done" data-task-id="${escapeHtml(task.id)}" type="button">Mark done</button>` : ""}</div>
  `).join("") || '<p class="settings-note">No project tasks yet.</p>';
  $("#project-source-list").innerHTML = (sources.sources || []).map((source) => `
    <div class="project-list-item"><header><strong>${escapeHtml(source.title)}</strong><span class="status-pill">${escapeHtml(source.status)}</span></header>
    <small>${escapeHtml(source.kind)} · ${Number(source.chunks)} indexed section${Number(source.chunks) === 1 ? "" : "s"}${source.sourcePath ? ` · ${escapeHtml(source.sourcePath)}` : ""}</small></div>
  `).join("") || '<p class="settings-note">No indexed sources yet.</p>';
  $$(".project-task-done").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(button.dataset.taskId)}`, {
        method: "PATCH", body: JSON.stringify({ status: "done" })
      });
      await refreshProjects();
    } catch (error) { toast(error.message, "error"); }
  }));
}

function fileKind(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type.startsWith("image/") || /\.(?:png|jpe?g|webp)$/.test(name)) return "image";
  if (/\.(?:md|markdown)$/.test(name)) return "markdown";
  if (/\.(?:txt|csv)$/.test(name)) return "text";
  return "source";
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function switchView(view) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.remove("active"));
  $(`#${view}-view`).classList.add("active");
  if (view === "intelligence") refreshIntelligence().catch((error) => toast(error.message, "error"));
  if (view === "mind") refreshObsidian().catch((error) => toast(error.message, "error"));
  if (view === "tools") {
    Promise.all([refreshTools(), refreshToolRecipes(), refreshObsidian()]).catch((error) => toast(error.message, "error"));
  }
  if (view === "marketplace") refreshMarketplace().catch((error) => toast(error.message, "error"));
  if (view === "projects") refreshProjects().catch((error) => toast(error.message, "error"));
  if (view === "agent") refreshAgentWorkspace().catch((error) => toast(error.message, "error"));
  if (view === "sandbox") refreshSandboxes().catch((error) => toast(error.message, "error"));
  if (view === "physics") refreshPhysics().catch((error) => toast(error.message, "error"));
  // The simulation clock must not keep running for a view nobody is looking at.
  else suspendPhysics();
  if (view === "lab") refreshLab().catch((error) => toast(error.message, "error"));
  // Leaving the lab releases the camera; a webcam light that stays on after you
  // navigate away is alarming, and rightly so.
  else suspendLab();
}

function renderEvolution() {
  if (!app.state) return;
  const total = app.state.feedback.length;
  const positive = app.state.feedback.filter((item) => item.rating === "up").length;
  const active = app.state.versions.find((version) => version.id === app.state.activeVersionId);
  $("#feedback-total").textContent = total;
  $("#feedback-positive").textContent = total ? `${Math.round((positive / total) * 100)}%` : "0%";
  $("#version-number").textContent = active?.number || 1;

  const proposal = app.state.pendingProposal;
  elements.noProposal.classList.toggle("hidden", Boolean(proposal));
  elements.proposalPanel.classList.toggle("hidden", !proposal);
  if (!proposal) return;
  $("#proposal-summary").textContent = proposal.summary;
  $("#proposal-model").textContent = proposal.evaluatorModel;
  $("#proposal-rationale").textContent = proposal.rationale;
  $("#proposal-prompt").textContent = proposal.prompt;
  $("#proposal-tests").innerHTML = proposal.tests.map((test) => `
    <div class="test"><strong>${escapeHtml(test.input)}</strong><span>${escapeHtml(test.expected)}</span></div>
  `).join("");
  const evaluation = proposal.evaluation;
  $("#proposal-evaluation").innerHTML = evaluation ? `
    <div class="evaluation-summary ${evaluation.recommended ? "recommended" : "not-recommended"}">
      <strong>${evaluation.recommended ? "EVALUATION RECOMMENDS THIS UPGRADE" : "EVALUATION DOES NOT RECOMMEND THIS UPGRADE"}</strong>
      <span>${evaluation.cases} cases · ${evaluation.wins} wins · ${evaluation.losses} losses · ${evaluation.ties} ties</span>
      <p>${escapeHtml(evaluation.reason)}</p>
    </div>
  ` : '<p class="settings-note">Run a blind evaluation against feedback-derived cases before deciding whether to activate this prompt.</p>';
}

function renderVersions() {
  if (!app.state) return;
  elements.versionsList.innerHTML = [...app.state.versions].reverse().map((version) => {
    const active = version.id === app.state.activeVersionId;
    return `
      <article class="version-card ${active ? "active" : ""}">
        <div class="version-index">v${version.number}</div>
        <div class="version-copy">
          <h3>${escapeHtml(version.summary)}</h3>
          <p>${escapeHtml(version.rationale)}</p>
          <small>${new Date(version.createdAt).toLocaleString()} · ${escapeHtml(version.source)}</small>
        </div>
        ${active ? '<span class="active-label">ACTIVE</span>' : `<button class="secondary-button activate-version" data-id="${escapeHtml(version.id)}">Restore</button>`}
      </article>
    `;
  }).join("");
  $$(".activate-version").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api("/api/versions/activate", {
        method: "POST",
        body: JSON.stringify({ versionId: button.dataset.id })
      });
      await refreshState();
      toast("Earlier mind restored.");
    } catch (error) {
      toast(error.message, "error");
    }
  }));
}

function renderMind() {
  if (!app.state) return;
  const knowledge = app.state.knowledge || [];
  $("#knowledge-count").textContent = `${knowledge.length} record${knowledge.length === 1 ? "" : "s"}`;
  $("#knowledge-list").innerHTML = knowledge.length ? [...knowledge].reverse().map((item) => `
    <article class="knowledge-item">
      <div class="knowledge-item-head">
        <h3>${escapeHtml(item.title)}</h3>
        <button class="delete-knowledge" data-id="${escapeHtml(item.id)}" title="Delete knowledge" aria-label="Delete ${escapeHtml(item.title)}">×</button>
      </div>
      <p>${escapeHtml(item.content)}</p>
      <div class="knowledge-meta">${escapeHtml(item.domain)} · ${item.embeddingStatus === "semantic" ? "SEMANTIC" : "KEYWORD"} RETRIEVAL</div>
    </article>
  `).join("") : '<div class="empty-panel"><h2>No knowledge yet</h2><p>Add approved facts, preferences, or domain references. Relevant records will be retrieved automatically.</p></div>';

  $$(".delete-knowledge").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/knowledge/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      await refreshState();
      toast("Knowledge record deleted.");
    } catch (error) {
      toast(error.message, "error");
    }
  }));

  const proposals = app.state.architectureProposals || [];
  $("#architecture-list").innerHTML = proposals.length ? [...proposals].reverse().map((proposal) => `
    <article class="architecture-item">
      <div class="architecture-item-head">
        <h3>${escapeHtml(proposal.title)}</h3>
        <span class="model-badge">${escapeHtml(proposal.model)}</span>
      </div>
      <p>${escapeHtml(proposal.summary)}</p>
      <div class="proposal-section"><strong>CHANGES</strong><ul>${proposal.changes.map((item) =>
        `<li><b>${escapeHtml(item.component)}:</b> ${escapeHtml(item.change)}</li>`).join("")}</ul></div>
      <div class="proposal-section"><strong>RISKS</strong><ul>${proposal.risks.map((item) =>
        `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
      <div class="proposal-section"><strong>TESTS</strong><ul>${proposal.tests.map((item) =>
        `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
    </article>
  `).join("") : '<div class="empty-panel"><h2>No architecture proposals</h2><p>Describe a desired improvement to produce a reviewable design with risks and tests.</p></div>';
}

async function refreshObsidian() {
  if (!$("#obsidian-status-badge")) return;
  const [status, changes] = await Promise.all([
    api("/api/obsidian"),
    api("/api/obsidian/changes?status=&limit=100")
  ]);
  app.obsidian = { ...status, changes: changes.changes || [] };
  $("#obsidian-status-badge").textContent = status.connected ? String(status.status || "connected").toUpperCase() : "DISCONNECTED";
  $("#obsidian-note-count").textContent = status.notes || 0;
  $("#obsidian-chunk-count").textContent = status.chunks || 0;
  $("#obsidian-link-count").textContent = status.links || 0;
  $("#obsidian-pending-count").textContent = status.pendingChanges || 0;
  $("#obsidian-connection-detail").textContent = status.connected
    ? `${status.label} / ${status.syncing ? "syncing now" : status.lastSyncAt ? `last sync ${new Date(status.lastSyncAt).toLocaleString()}` : "not synced yet"} / migration ${status.migration?.complete ? `${status.migration.exported || 0} verified` : "not started"}${status.lastError ? ` / ${status.lastError}` : ""}`
    : status.desktopAvailable ? "Choose a dedicated vault. Its full path never enters the browser UI." : "Live folders require the Evolv desktop app. Manual import and export remain available.";
  $("#obsidian-connect").disabled = !status.desktopAvailable;
  $("#obsidian-sync").disabled = !status.connected;
  $("#obsidian-open").disabled = !status.connected || !status.desktopAvailable;
  $("#obsidian-disconnect").disabled = !status.connected;
  const visibleChanges = app.obsidian.changes.filter((change) => ["pending", "approved"].includes(change.status)).slice(0, 30);
  $("#obsidian-changes").innerHTML = visibleChanges.length ? visibleChanges.map((change) => `
    <article class="vault-change-card" data-change-id="${escapeHtml(change.id)}">
      <div class="tool-run-head"><h3>${escapeHtml(change.kind.toUpperCase())} / ${escapeHtml(change.path)}</h3><span class="model-badge">${change.status === "pending" ? "APPROVAL REQUIRED" : "APPLIED"}</span></div>
      <p>${escapeHtml(change.summary || "Review the complete note change.")}</p>
      ${change.destinationPath ? `<p class="tool-meta">DESTINATION: ${escapeHtml(change.destinationPath)}</p>` : ""}
      ${change.beforeContent ? `<details><summary>Before</summary><pre class="diff-before">${escapeHtml(change.beforeContent)}</pre></details>` : ""}
      ${change.afterContent ? `<details open><summary>After</summary><pre class="diff-after">${escapeHtml(change.afterContent)}</pre></details>` : ""}
      <div class="data-actions">
        ${change.status === "pending" ? `
          <button class="primary-button vault-change-decision" data-decision="approved" type="button">Approve and apply</button>
          <button class="secondary-button vault-change-decision" data-decision="rejected" type="button">Reject</button>
        ` : '<button class="secondary-button vault-change-undo" type="button">Undo safely</button>'}
      </div>
    </article>
  `).join("") : '<p class="settings-note">No generated note changes are waiting.</p>';
}

async function decideVaultChange(card, decision) {
  const result = await api(`/api/obsidian/changes/${encodeURIComponent(card.dataset.changeId)}/decision`, {
    method: "POST", body: JSON.stringify({ decision })
  });
  await Promise.all([refreshObsidian(), refreshTools(), refreshMemory()]);
  toast(decision === "approved" ? "Obsidian change approved and synced." : "Obsidian change rejected.");
  if (result.continuationAvailable && result.conversationIds?.includes(app.conversationId) && !app.generating) {
    await streamAssistantResponse({ continuation: true, ...(result.agentRunId ? { resumeRunId: result.agentRunId } : {}) });
  }
}

async function searchObsidianNotes() {
  const container = $("#obsidian-note-results");
  if (!container || !app.obsidian?.connected) {
    if (container) container.innerHTML = "";
    return;
  }
  const query = $("#obsidian-note-search").value.trim();
  if (!query) {
    container.innerHTML = "";
    return;
  }
  const payload = await api(`/api/obsidian/notes?query=${encodeURIComponent(query)}&limit=25`);
  container.innerHTML = payload.notes?.length ? payload.notes.map((note) => `
    <article class="knowledge-item">
      <div class="knowledge-item-head"><h3>${escapeHtml(note.title)}</h3><button class="secondary-button open-vault-search-note" data-note-id="${escapeHtml(note.id)}" type="button">Open</button></div>
      <p>${escapeHtml(note.path)}</p>
      <div class="knowledge-meta">${escapeHtml(note.type.toUpperCase())} / ${escapeHtml((note.tags || []).join(", ") || "NO TAGS")}</div>
    </article>`).join("") : '<p class="settings-note">No matching vault notes.</p>';
}

async function refreshToolRecipes() {
  if (!$("#tool-recipe-proposals")) return;
  const modelSelect = $("#tool-recipe-model");
  const previousModel = modelSelect.value;
  modelSelect.innerHTML = (app.models || []).map((model) =>
    `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}</option>`).join("");
  const preferredModel = previousModel || (elements.model.value !== "auto" ? elements.model.value : "");
  if ([...modelSelect.options].some((option) => option.value === preferredModel)) modelSelect.value = preferredModel;
  const payload = await api("/api/tool-recipes?limit=100");
  app.toolRecipes = payload.proposals || [];
  const pending = app.toolRecipes.filter((proposal) => proposal.status === "pending");
  $("#tool-recipe-proposals").innerHTML = pending.length ? pending.map((proposal) => `
    <article class="tool-card recipe-proposal" data-recipe-id="${escapeHtml(proposal.id)}">
      <div class="tool-card-head">
        <h3>macro_${escapeHtml(proposal.definition.name || "recipe")}</h3>
        <span class="model-badge">PENDING INSTALL</span>
      </div>
      <p>${escapeHtml(proposal.definition.description || proposal.request)}</p>
      <div class="recipe-badges">
        ${(proposal.validation.permissions || proposal.definition.permissions || []).map((permission) => `<span class="model-badge">${escapeHtml(String(permission).toUpperCase())}</span>`).join("")}
        <span class="model-badge">${proposal.definition.steps?.length || 0} CALLS</span>
      </div>
      <textarea class="recipe-editor" rows="16" spellcheck="false">${escapeHtml(JSON.stringify(proposal.definition, null, 2))}</textarea>
      <div class="recipe-dry-run"></div>
      <div class="data-actions">
        <button class="secondary-button recipe-dry-run-button" type="button">Validate and dry run</button>
        <button class="primary-button recipe-decision" data-decision="approved" type="button">Approve and install</button>
        <button class="secondary-button recipe-decision" data-decision="rejected" type="button">Reject</button>
      </div>
    </article>
  `).join("") : '<p class="settings-note">No generated recipes are waiting for review.</p>';
}

async function saveRecipeEditor(card) {
  let definition;
  try { definition = JSON.parse(card.querySelector(".recipe-editor").value); }
  catch { throw new Error("The recipe editor must contain valid JSON."); }
  return api(`/api/tool-recipes/${encodeURIComponent(card.dataset.recipeId)}`, {
    method: "PATCH", body: JSON.stringify({ definition })
  });
}

async function refreshTools() {
  if (!elements.toolsList) return;
  const [toolsPayload, runsPayload] = await Promise.all([
    api("/api/tools"),
    api("/api/tool-runs?limit=100")
  ]);
  app.tools = toolsPayload.tools || [];
  elements.toolsMaster.checked = toolsPayload.enabled;
  elements.toolsList.innerHTML = app.tools.map((tool) => `
    <article class="tool-card">
      <div class="tool-card-head">
        <h3>${escapeHtml(tool.name)}</h3>
        <label class="tool-switch"><input type="checkbox" data-tool-name="${escapeHtml(tool.name)}" ${tool.enabled ? "checked" : ""} /> Enabled</label>
      </div>
      <p>${escapeHtml(tool.description)}</p>
      <div class="tool-meta">${escapeHtml(tool.risk.toUpperCase())} · ${tool.timeoutMs}MS · ${tool.outputLimit} CHAR LIMIT</div>
    </article>
  `).join("");
  elements.toolRunsList.innerHTML = runsPayload.runs?.length ? runsPayload.runs.map((run) => `
    <article class="tool-run-card ${run.status === "failed" ? "failed" : ""}">
      <div class="tool-run-head"><h3>${escapeHtml(run.toolName)}</h3><span class="model-badge">${escapeHtml(run.status)}</span></div>
      <p>${escapeHtml(run.resultSummary || run.error || "No result summary")}</p>
      ${run.status === "pending-approval" ? `<div class="data-actions">
        <button class="primary-button audit-run-decision" data-run-id="${escapeHtml(run.id)}" data-decision="approved" type="button">Approve action</button>
        <button class="secondary-button audit-run-decision" data-run-id="${escapeHtml(run.id)}" data-decision="rejected" type="button">Reject</button>
      </div>` : ""}
      <div class="tool-meta">${run.durationMs}MS · ${escapeHtml(run.decision)} · ${new Date(run.createdAt).toLocaleString()}</div>
    </article>
  `).join("") : '<div class="empty-panel"><h2>No tool activity</h2><p>Tool calls will appear here with their status and duration.</p></div>';
  $$("[data-tool-name]").forEach((input) => input.addEventListener("change", async () => {
    try {
      await api(`/api/tools/${encodeURIComponent(input.dataset.toolName)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: input.checked })
      });
      toast(`${input.dataset.toolName} ${input.checked ? "enabled" : "disabled"}.`);
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message, "error");
    }
  }));
  $$(".audit-run-decision").forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api(`/api/tool-runs/${encodeURIComponent(button.dataset.runId)}/decision`, {
        method: "POST", body: JSON.stringify({ decision: button.dataset.decision })
      });
      await Promise.all([refreshTools(), refreshObsidian()]);
      toast(button.dataset.decision === "approved" ? "Approved action completed." : "Action rejected; nothing was changed.");
      if (result.continuationAvailable && result.conversationId === app.conversationId && !app.generating) {
        await streamAssistantResponse({ continuation: true, ...(result.agentRunId ? { resumeRunId: result.agentRunId } : {}) });
      }
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function saveKnowledge(event) {
  event.preventDefault();
  const button = $("#knowledge-save");
  button.disabled = true;
  button.textContent = "Embedding…";
  try {
    const item = await api("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        title: $("#knowledge-title").value,
        domain: $("#knowledge-domain").value,
        content: $("#knowledge-content").value
      })
    });
    event.currentTarget.reset();
    await refreshState();
    toast(item.embeddingStatus === "semantic" ? "Knowledge embedded and saved." : "Knowledge saved with keyword retrieval.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Embed & save";
  }
}

async function refreshMemory() {
  if (!$("#memory-list")) return;
  app.memory = await api("/api/memory");
  renderMemory();
}

// Escapes first, then styles [[Title]] / [[Title|alias]] mentions.
function renderMemoryBody(body) {
  return escapeHtml(body).replace(/\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]/g, (match, target, alias) =>
    `<span class="wikilink" title="${target.trim()}">${(alias || target).trim()}</span>`);
}

function renderMemory() {
  const nodes = app.memory?.nodes || [];
  const edges = app.memory?.edges || [];
  const proposed = nodes.filter((node) => node.status === "proposed");
  const profile = nodes.filter((node) => node.status === "active" && node.type === "preference");
  for (const prefix of [""]) {
    const count = $(`#${prefix}adaptive-profile-count`);
    const list = $(`#${prefix}adaptive-profile-list`);
    if (!count || !list) continue;
    count.textContent = `${profile.length} approved`;
    list.innerHTML = profile.length ? profile.map((node) => `
      <article class="adaptive-profile-item">
        <strong>${escapeHtml(node.title)}</strong>
        <p>${escapeHtml(node.body)}</p>
      </article>
    `).join("") : '<p class="settings-note">No preferences are active yet. State a preference in chat, then approve its proposal in Intelligence.</p>';
  }
  const activeCount = nodes.filter((node) => node.status === "active").length;
  $("#memory-count").textContent = `${activeCount} active${proposed.length ? ` · ${proposed.length} proposed` : ""}`;
  const linkCount = (node) => edges.filter((edge) => edge.fromId === node.id || edge.toId === node.id).length;
  const card = (node) => `
    <article class="knowledge-item ${node.status === "proposed" ? "memory-proposed" : ""} ${["resolved", "archived"].includes(node.status) ? "memory-retired" : ""}">
      <div class="knowledge-item-head">
        <h3>${escapeHtml(node.title)}</h3>
        <button class="delete-knowledge delete-memory" data-id="${escapeHtml(node.id)}" title="Delete memory" aria-label="Delete ${escapeHtml(node.title)}">×</button>
      </div>
      <p>${renderMemoryBody(node.body)}</p>
      <div class="knowledge-meta">${escapeHtml(node.type.toUpperCase())} · ${escapeHtml(node.status.toUpperCase())}${node.source === "extracted" ? " · MODEL-PROPOSED" : ""}${node.source === "obsidian" ? " · VAULT" : ""}${linkCount(node) ? ` · ${linkCount(node)} LINK${linkCount(node) === 1 ? "" : "S"}` : ""}</div>
      <div class="data-actions memory-actions">
        ${node.status === "proposed" ? `<button class="primary-button approve-memory" data-id="${escapeHtml(node.id)}">Approve</button>` : ""}
        ${node.status === "active" ? `<button class="secondary-button retire-memory" data-id="${escapeHtml(node.id)}" data-status="${node.type === "task" ? "resolved" : "archived"}">${node.type === "task" ? "Resolve" : "Archive"}</button>` : ""}
        ${["resolved", "archived"].includes(node.status) ? `<button class="secondary-button reactivate-memory" data-id="${escapeHtml(node.id)}">Reactivate</button>` : ""}
      </div>
    </article>
  `;
  const ordered = [...proposed, ...nodes.filter((node) => node.status !== "proposed")];
  $("#memory-list").innerHTML = ordered.length
    ? ordered.map(card).join("")
    : '<p class="settings-note">Nothing remembered yet. Add a record above, or extract memory from a conversation.</p>';
  const patchMemory = async (id, patch, message) => {
    try {
      await api(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      await refreshMemory();
      toast(message);
    } catch (error) {
      toast(error.message, "error");
    }
  };
  $$(".approve-memory").forEach((button) => button.addEventListener("click", () =>
    patchMemory(button.dataset.id, { status: "active" }, "Memory approved. It is now part of Evolv's context.")));
  $$(".retire-memory").forEach((button) => button.addEventListener("click", () =>
    patchMemory(button.dataset.id, { status: button.dataset.status }, button.dataset.status === "resolved" ? "Task resolved." : "Memory archived.")));
  $$(".reactivate-memory").forEach((button) => button.addEventListener("click", () =>
    patchMemory(button.dataset.id, { status: "active" }, "Memory reactivated.")));
  $$(".delete-memory").forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api(`/api/memory/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      await refreshMemory();
      if (result.archived) await refreshObsidian();
      toast(result.archived ? "Memory archived in Obsidian; history was preserved." : "Memory deleted.");
    } catch (error) {
      toast(error.message, "error");
    }
  }));
}

async function saveMemory(event) {
  event.preventDefault();
  const button = $("#memory-save");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await api("/api/memory", {
      method: "POST",
      body: JSON.stringify({
        title: $("#memory-title").value,
        type: $("#memory-type").value,
        body: $("#memory-body").value
      })
    });
    event.currentTarget.reset();
    await refreshMemory();
    toast("Remembered.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Remember";
  }
}

async function extractMemoryFromChat() {
  if (!app.conversationId) {
    toast("Open a conversation first.", "error");
    return;
  }
  if (!elements.model.value || elements.model.value === "auto") {
    toast("Choose a specific model for manual memory extraction.", "error");
    return;
  }
  const button = $("#memory-extract");
  button.disabled = true;
  button.textContent = "Reviewing conversation…";
  try {
    const result = await api("/api/memory/extract", {
      method: "POST",
      body: JSON.stringify({
        conversationId: app.conversationId,
        provider: app.settings.provider,
        model: elements.model.value
      })
    });
    await refreshMemory();
    toast(result.proposed.length
      ? `${result.proposed.length} memory proposal${result.proposed.length === 1 ? "" : "s"} await your review.`
      : "The model found nothing new worth remembering.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Extract memory from current conversation";
  }
}

async function exportVault() {
  const button = $("#vault-export");
  button.disabled = true;
  try {
    const result = await api("/api/memory/vault/export", { method: "POST", body: "{}" });
    toast(`Exported ${result.count} note${result.count === 1 ? "" : "s"} to ${result.path}. Open that folder as a vault in Obsidian.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function importVault(fileList) {
  const files = [...fileList].filter((file) => /\.md$/i.test(file.name)).slice(0, 500);
  if (!files.length) {
    toast("Choose one or more .md notes.", "error");
    return;
  }
  const button = $("#vault-import");
  button.disabled = true;
  button.textContent = "Importing…";
  try {
    const payload = await Promise.all(files.map(async (file) => ({ name: file.name, content: await file.text() })));
    const result = await api("/api/memory/vault/import", {
      method: "POST",
      body: JSON.stringify({ files: payload })
    });
    await refreshMemory();
    toast(`Vault import: ${result.created} added, ${result.linked} linked, ${result.skipped} already known.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Import vault…";
  }
}

async function refreshMacros() {
  if (!$("#macro-list")) return;
  app.macros = await api("/api/tool-macros");
  renderMacros();
}

// Drafts an editable macro definition from a mined suggestion. Required
// arguments become macro inputs; a read following a search is pre-wired to
// consume the first search hit.
function macroDraftFromSuggestion(suggestion) {
  const inputs = [];
  const steps = suggestion.tools.map((tool, index) => {
    const earlierSearch = suggestion.tools.slice(0, index).lastIndexOf("search_workspace_text");
    if (tool === "read_workspace_text" && earlierSearch !== -1) {
      return { tool, args: { path: `{{steps.${earlierSearch}.output.0.path}}` } };
    }
    const schema = app.tools.find((item) => item.name === tool)?.schema;
    const required = schema?.required || Object.keys(schema?.properties || {}).slice(0, 1);
    const args = {};
    for (const property of required) {
      const inputName = inputs.some((input) => input.name === property) ? `${tool}_${property}` : property;
      inputs.push({ name: inputName, description: `${property} for ${tool}`, required: true });
      args[property] = `{{input.${inputName}}}`;
    }
    return { tool, args };
  });
  return {
    name: suggestion.suggestedName,
    title: suggestion.title,
    description: suggestion.description,
    steps,
    inputs,
    evidence: { count: suggestion.count, conversations: suggestion.conversations }
  };
}

function renderMacros() {
  const macros = app.macros?.macros || [];
  const suggestions = app.macros?.suggestions || [];
  $("#macro-suggestions").innerHTML = suggestions.length ? suggestions.map((suggestion, index) => `
    <article class="tool-card">
      <div class="tool-card-head">
        <h3>${escapeHtml(suggestion.title)}</h3>
        <span class="model-badge">SEEN ${suggestion.count}×</span>
      </div>
      <p>${escapeHtml(suggestion.description)}</p>
      <div class="data-actions">
        <button class="secondary-button review-suggestion" data-index="${index}">Review & approve…</button>
        <button class="secondary-button dismiss-suggestion" data-index="${index}">Dismiss</button>
      </div>
      <div class="macro-editor hidden" data-editor="${index}">
        <textarea rows="12" spellcheck="false" aria-label="Macro definition"></textarea>
        <div class="data-actions">
          <button class="primary-button create-macro" data-index="${index}">Approve as composite tool</button>
        </div>
      </div>
    </article>
  `).join("") : '<p class="settings-note">No repeated tool pipelines detected yet.</p>';
  $("#macro-list").innerHTML = macros.length ? macros.map((macro) => `
    <article class="tool-card">
      <div class="tool-card-head">
        <h3>macro_${escapeHtml(macro.name)}</h3>
        <label class="tool-switch"><input type="checkbox" data-macro-id="${escapeHtml(macro.id)}" ${macro.enabled ? "checked" : ""} /> Enabled</label>
      </div>
      <p>${escapeHtml(macro.title)}${macro.description ? ` — ${escapeHtml(macro.description)}` : ""}</p>
      <div class="tool-meta">${macro.steps.map((step) => escapeHtml(step.tool)).join(" → ")} · USER-APPROVED</div>
      <div class="data-actions">
        <button class="secondary-button macro-versions" data-id="${escapeHtml(macro.id)}">Versions</button>
        <button class="secondary-button delete-macro" data-id="${escapeHtml(macro.id)}">Delete</button>
      </div>
      <div class="recipe-version-list" data-version-list="${escapeHtml(macro.id)}"></div>
    </article>
  `).join("") : '<p class="settings-note">No composite tools yet. Approve a suggested pipeline to create one.</p>';

  $$(".review-suggestion").forEach((button) => button.addEventListener("click", () => {
    const editor = $(`[data-editor="${button.dataset.index}"]`);
    const textarea = editor.querySelector("textarea");
    if (!textarea.value) {
      textarea.value = JSON.stringify(macroDraftFromSuggestion(suggestions[button.dataset.index]), null, 2);
    }
    editor.classList.toggle("hidden");
  }));
  $$(".create-macro").forEach((button) => button.addEventListener("click", async () => {
    const editor = $(`[data-editor="${button.dataset.index}"]`);
    try {
      const definition = JSON.parse(editor.querySelector("textarea").value);
      const macro = await api("/api/tool-macros", { method: "POST", body: JSON.stringify(definition) });
      await refreshMacros();
      toast(`macro_${macro.name} is now available to tool-capable models.`);
    } catch (error) {
      toast(error.message.startsWith("Unexpected") ? "The macro definition is not valid JSON." : error.message, "error");
    }
  }));
  $$(".dismiss-suggestion").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api("/api/tool-macros", {
        method: "POST",
        body: JSON.stringify({ dismiss: true, tools: suggestions[button.dataset.index].tools })
      });
      await refreshMacros();
      toast("Suggestion dismissed. It will not be offered again.");
    } catch (error) {
      toast(error.message, "error");
    }
  }));
  $$("[data-macro-id]").forEach((input) => input.addEventListener("change", async () => {
    try {
      await api(`/api/tool-macros/${encodeURIComponent(input.dataset.macroId)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: input.checked })
      });
      toast(`Composite tool ${input.checked ? "enabled" : "disabled"}.`);
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message, "error");
    }
  }));
  $$(".delete-macro").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/tool-macros/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      await refreshMacros();
      toast("Composite tool deleted.");
    } catch (error) {
      toast(error.message, "error");
    }
  }));
  $$(".macro-versions").forEach((button) => button.addEventListener("click", async () => {
    const list = $(`[data-version-list="${button.dataset.id}"]`);
    try {
      const payload = await api(`/api/tool-recipes/macros/${encodeURIComponent(button.dataset.id)}/versions`);
      list.innerHTML = payload.versions?.length ? payload.versions.map((version) => `
        <div class="route-history-item">
          <strong>Version ${version.version}</strong><span>${version.active ? "ACTIVE" : escapeHtml(version.hash.slice(0, 10))}</span>
          <small>${new Date(version.createdAt).toLocaleString()}</small>
          ${version.active ? "" : `<button class="secondary-button rollback-recipe" data-macro-id="${escapeHtml(button.dataset.id)}" data-version-id="${escapeHtml(version.id)}">Rollback</button>`}
        </div>`).join("") : '<p class="settings-note">This manually created macro has no generated versions.</p>';
      list.querySelectorAll(".rollback-recipe").forEach((rollback) => rollback.addEventListener("click", async () => {
        try {
          await api(`/api/tool-recipes/macros/${encodeURIComponent(rollback.dataset.macroId)}/versions/${encodeURIComponent(rollback.dataset.versionId)}/rollback`, {
            method: "POST", body: "{}"
          });
          await refreshMacros();
          toast("Generated tool rolled back to the selected approved version.");
        } catch (error) { toast(error.message, "error"); }
      }));
    } catch (error) { toast(error.message, "error"); }
  }));
}

async function designArchitecture(event) {
  event.preventDefault();
  if (!elements.model.value || elements.model.value === "auto") {
    toast("Choose a specific model to design an architecture proposal.", "error");
    return;
  }
  const button = $("#architecture-propose");
  button.disabled = true;
  button.textContent = "Designing…";
  try {
    await api("/api/architecture/propose", {
      method: "POST",
      body: JSON.stringify({
        provider: app.settings.provider,
        model: elements.model.value,
        request: $("#architecture-request").value
      })
    });
    event.currentTarget.reset();
    await refreshState();
    toast("Architecture proposal created. No files were changed.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Design proposal";
  }
}

async function proposeUpgrade() {
  if (!app.state?.feedback.length) {
    toast("Rate at least one answer before generating an upgrade.", "error");
    return;
  }
  if (!elements.model.value || elements.model.value === "auto") {
    toast("Choose a specific evaluator model first.", "error");
    return;
  }
  elements.propose.disabled = true;
  elements.propose.textContent = "Reviewing feedback…";
  try {
    await api("/api/improve", {
      method: "POST",
      body: JSON.stringify({
        provider: app.settings.provider,
        model: elements.model.value,
        think: parseThink(elements.think.value)
      })
    });
    await refreshState();
    toast("Upgrade proposal is ready for review.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.propose.disabled = false;
    elements.propose.textContent = "Generate upgrade";
  }
}

async function evaluateProposal() {
  if (!app.state?.pendingProposal) return;
  if (!elements.model.value || elements.model.value === "auto") {
    toast("Choose a specific evaluator model before running a blind evaluation.", "error");
    return;
  }
  const button = $("#evaluate-proposal");
  button.disabled = true;
  button.textContent = "Evaluating…";
  try {
    const result = await api("/api/intelligence/evaluations", {
      method: "POST",
      body: JSON.stringify({ provider: app.settings.provider, model: elements.model.value })
    });
    await Promise.all([refreshState(), refreshIntelligence()]);
    toast(result.summary?.recommended ? "The blind evaluation recommends this upgrade." : "The upgrade did not outperform the active prompt.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Run blind evaluation";
  }
}

async function startNewChat({ preservePack = false, title = "New conversation" } = {}) {
  stopSpeech();
  if (!preservePack) clearActivePack();
  const conversation = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title })
  });
  app.conversationId = conversation.id;
  app.messages = [];
  saveLocal();
  renderMessages();
  renderActivePack();
  await refreshConversations();
  switchView("chat");
  elements.prompt.focus();
}

function bindEvents() {
  elements.projectSelect?.addEventListener("change", async () => {
    app.activeProjectId = elements.projectSelect.value;
    localStorage.setItem("evolv:active-project", app.activeProjectId);
    await refreshProjects().catch((error) => toast(error.message, "error"));
  });
  $("#project-refresh")?.addEventListener("click", () => refreshProjects().catch((error) => toast(error.message, "error")));
  $("#project-demo")?.addEventListener("click", async () => {
    const button = $("#project-demo");
    button.disabled = true;
    button.textContent = "Loading verified demo…";
    try {
      const result = await api("/api/projects/demo", { method: "POST", body: "{}" });
      app.activeProjectId = result.project.id;
      await refreshProjects();
      toast(result.created ? "Verified demo project created." : "Verified demo project already exists.");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Load verified demo";
    }
  });
  $("#project-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const project = await api("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      app.activeProjectId = project.id;
      localStorage.setItem("evolv:active-project", project.id);
      form.reset();
      await refreshProjects();
      toast("Project created. Connect its folder when you want Evolv to read project files.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#project-connect-folder")?.addEventListener("click", async () => {
    const project = activeProject();
    if (!project) return;
    if (!window.evolvProjects?.chooseFolder) return toast("Project folders can be connected only in Evolv.exe.", "error");
    try {
      const picked = await window.evolvProjects.chooseFolder();
      if (picked.canceled) return;
      await api(`/api/projects/${encodeURIComponent(project.id)}/connect`, { method: "POST", body: JSON.stringify({ grant: picked.grant }) });
      await refreshProjects();
      toast("Project folder connected. Evolv still needs your approval before any write.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#project-sync-files")?.addEventListener("click", async (event) => {
    const project = activeProject(); if (!project) return;
    const button = event.currentTarget; button.disabled = true; button.textContent = "Indexing…";
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/sync`, { method: "POST", body: "{}" });
      await refreshProjects();
      toast(`Indexed ${result.files} permitted project files.`);
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; button.textContent = "Index project files"; }
  });
  $("#project-task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const project = activeProject(); if (!project) return;
    const form = event.currentTarget;
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/tasks`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await refreshProjects();
    } catch (error) { toast(error.message, "error"); }
  });
  $("#project-source-form")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const project = activeProject(); if (!project) return;
    const form = event.currentTarget; const fields = new FormData(form); const file = fields.get("source");
    if (!(file instanceof File) || !file.size) return;
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = "Importing…";
    try {
      const kind = fileKind(file);
      const payload = { title: fields.get("title"), kind, mimeType: file.type, caption: fields.get("caption"), sourcePath: file.name };
      if (["text", "markdown", "source"].includes(kind)) payload.text = await file.text();
      else payload.dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      const source = await api(`/api/projects/${encodeURIComponent(project.id)}/sources`, { method: "POST", body: JSON.stringify(payload) });
      form.reset(); await refreshProjects();
      toast(source.status === "metadata-only" ? "Image stored and indexed from its caption/metadata; OCR was not claimed." : "Source imported with citations.");
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; button.textContent = "Import and index"; }
  });
  $("#project-search-form")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const project = activeProject(); if (!project) return;
    const query = new FormData(event.currentTarget).get("query");
    try {
      const payload = await api(`/api/projects/${encodeURIComponent(project.id)}/search?q=${encodeURIComponent(query)}`);
      $("#project-search-results").innerHTML = (payload.results || []).map((result) => `
        <div class="project-list-item"><header><strong>${escapeHtml(result.title)}</strong><span class="status-pill">${Number(result.score).toFixed(2)}</span></header>
        <small>${result.sourcePath ? `${escapeHtml(result.sourcePath)} · ` : ""}${escapeHtml(result.locator)}</small><p>${escapeHtml(result.content.slice(0, 500))}</p></div>
      `).join("") || '<p class="settings-note">No matching project source.</p>';
    } catch (error) { toast(error.message, "error"); }
  });
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(elements.prompt.value);
  });
  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
      return;
    }
    // Up-arrow in an empty composer edits the last thing you said, the way a
    // shell recalls the last command.
    if (event.key === "ArrowUp" && !elements.prompt.value && !app.generating) {
      const offset = [...app.messages].reverse().findIndex((message) => message.role === "user");
      if (offset >= 0) {
        event.preventDefault();
        startEditingMessage(app.messages.length - 1 - offset);
      }
    }
  });
  elements.prompt.addEventListener("input", () => {
    resizePrompt();
    renderCommandMenu();
  });
  elements.commandMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button) return;
    elements.prompt.value = button.dataset.command;
    hideCommandMenu();
    elements.composer.requestSubmit();
  });
  elements.editCancel?.addEventListener("click", cancelEditing);
  elements.saveChat?.addEventListener("click", saveChatToVault);
  elements.stop.addEventListener("click", async () => {
    const activeMessage = [...app.messages].reverse().find((message) => message.streaming && message.agentRun?.id);
    try {
      if (activeMessage?.agentRun?.id) {
        const paused = await api(`/api/runs/${encodeURIComponent(activeMessage.agentRun.id)}/pause`, { method: "POST", body: "{}" });
        activeMessage.agentRun = { ...activeMessage.agentRun, state: paused.state, budgets: paused.budgets };
      }
    } catch (error) {
      toast(`Could not pause the run cleanly: ${error.message}`, "error");
    } finally {
      app.controller?.abort();
    }
  });
  elements.messages.addEventListener("click", async (event) => {
    const button = event.target.closest(".code-copy");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code");
    button.dataset.copiedLabel = "Copied";
    await copyText(code?.textContent || "", button);
  });
  elements.model.addEventListener("change", () => {
    app.settings.model = elements.model.value;
    configureReasoning(elements.model.value);
    updateFavoriteButton();
    warnAboutFit();
    persistAiSettings();
  });
  elements.favoriteModel.addEventListener("click", toggleFavoriteModel);
  elements.provider.addEventListener("change", async () => {
    app.settings.provider = elements.provider.value;
    app.settings.model = "";
    persistAiSettings();
    await refreshModels();
  });
  elements.providerSettingsList?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.classList.contains("provider-save")) providerAction(button, "save");
    if (button.classList.contains("provider-test")) providerAction(button, "test");
    if (button.classList.contains("provider-delete")) providerAction(button, "delete");
  });
  $("#intelligence-refresh")?.addEventListener("click", () => refreshIntelligence({ refreshModels: true }).catch((error) => toast(error.message, "error")));
  $("#save-intelligence-settings")?.addEventListener("click", async () => {
    try {
      await api("/api/intelligence/settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoRouting: $("#auto-routing-enabled").checked,
          autoMemory: $("#auto-memory-enabled").checked,
          autoCloudProviders: $$('[data-auto-cloud]:checked').map((input) => input.dataset.autoCloud),
          vaultCloudProviders: $$('[data-vault-cloud]:checked').map((input) => input.dataset.vaultCloud),
          projectCloudProviders: $$('[data-project-cloud]:checked').map((input) => input.dataset.projectCloud),
          evaluationLimit: Number($("#evaluation-limit").value),
          monthlyCostLimit: Number($("#monthly-cost-limit").value)
        })
      });
      await refreshIntelligence();
      toast("Intelligence settings saved.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#save-agent-models")?.addEventListener("click", async () => {
    try {
      // Every specialist is sent, including the ones set back to empty, so
      // clearing a pin is a change rather than an omission.
      const agentModels = Object.fromEntries($$("[data-agent-model]").map((select) => [select.dataset.agentModel, select.value]));
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ agentModels }) });
      await renderAgentModelPins();
      const pinned = Object.values(agentModels).filter(Boolean).length;
      toast(pinned ? `Saved. ${pinned} specialist${pinned === 1 ? "" : "s"} pinned to a model.` : "Saved. Every specialist uses the goal's own model.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#intelligence-models")?.addEventListener("click", async (event) => {
    const button = event.target.closest(".save-model-preference");
    if (!button) return;
    const card = button.closest(".intelligence-model");
    try {
      const preference = Object.fromEntries([...card.querySelectorAll("[data-pref]")].map((input) => [
        input.dataset.pref, input.type === "checkbox" ? input.checked : Number(input.value)
      ]));
      await api(`/api/intelligence/models/${encodeURIComponent(card.dataset.provider)}/${encodeURIComponent(card.dataset.model)}`, {
        method: "PATCH", body: JSON.stringify(preference)
      });
      await refreshIntelligence();
      toast("Auto model preference saved.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#memory-proposal-list")?.addEventListener("click", async (event) => {
    const card = event.target.closest(".memory-proposal");
    if (!card) return;
    try {
      if (event.target.closest(".memory-proposal-approve")) await reviewMemoryProposal(card, "approved");
      if (event.target.closest(".memory-proposal-reject")) await reviewMemoryProposal(card, "rejected");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#evaluation-history")?.addEventListener("click", async (event) => {
    const card = event.target.closest(".intelligence-upgrade");
    if (!card) return;
    const decision = event.target.closest(".approve-intelligence-upgrade") ? "approved"
      : event.target.closest(".reject-intelligence-upgrade") ? "rejected" : "";
    if (!decision) return;
    try {
      await api(`/api/intelligence/upgrades/${encodeURIComponent(card.dataset.upgradeId)}`, {
        method: "PATCH", body: JSON.stringify({ decision })
      });
      await refreshIntelligence();
      toast(decision === "approved" ? "Routing upgrade approved." : "Routing upgrade rejected.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#strategy-candidate-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const failurePatternIds = $$('[data-failure-pattern]:checked').map((input) => input.dataset.failurePattern);
    try {
      await api("/api/evolution/strategies", {
        method: "POST",
        body: JSON.stringify({ ...values, failurePatternIds })
      });
      event.currentTarget.reset();
      await refreshIntelligence();
      toast("Candidate saved for testing. Nothing was activated.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#strategy-version-list")?.addEventListener("click", async (event) => {
    const card = event.target.closest(".strategy-version");
    if (!card) return;
    const strategyId = card.dataset.strategyId;
    try {
      if (event.target.closest(".benchmark-strategy")) {
        const provider = elements.provider.value;
        const model = elements.model.value;
        if (!model || model === "auto") return toast("Choose a specific model in the top bar before benchmarking.", "error");
        const cloud = provider !== "ollama";
        const warning = `This runs 5 fixed cases against the baseline and candidate (10 model calls).${cloud ? " Your cloud provider may charge for all 10 calls." : " It will use your local model."} Continue?`;
        if (!window.confirm(warning)) return;
        const button = event.target.closest(".benchmark-strategy");
        button.disabled = true;
        button.textContent = "Running 10 calls…";
        await api(`/api/evolution/strategies/${encodeURIComponent(strategyId)}/benchmark`, {
          method: "POST", body: JSON.stringify({ provider, model })
        });
        await refreshIntelligence();
        toast("Benchmark complete. Review the measured comparison before approval.");
      } else if (event.target.closest(".approve-strategy")) {
        await api(`/api/evolution/strategies/${encodeURIComponent(strategyId)}/decision`, {
          method: "POST", body: JSON.stringify({ decision: "approved", benchmarkRunId: card.dataset.benchmarkId })
        });
        await refreshIntelligence();
        toast("Tested strategy explicitly approved and activated.");
      } else if (event.target.closest(".reject-strategy")) {
        await api(`/api/evolution/strategies/${encodeURIComponent(strategyId)}/decision`, {
          method: "POST", body: JSON.stringify({ decision: "rejected" })
        });
        await refreshIntelligence();
        toast("Candidate rejected. Active behavior was not changed.");
      }
    } catch (error) {
      await refreshIntelligence().catch(() => {});
      toast(error.message, "error");
    }
  });
  $("#rollback-strategy")?.addEventListener("click", async () => {
    if (!window.confirm("Restore the strategy that was active before the current approved strategy?")) return;
    try {
      await api("/api/evolution/rollback", { method: "POST", body: "{}" });
      await refreshIntelligence();
      toast("Previous approved strategy restored.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#approve-selected-memories")?.addEventListener("click", async () => {
    const ids = $$('[data-memory-select]:checked').map((input) => input.closest(".memory-proposal").dataset.proposalId);
    if (!ids.length) return toast("Select at least one memory proposal.", "error");
    try {
      await api("/api/memory-proposals/review", { method: "POST", body: JSON.stringify({ ids, decision: "approved" }) });
      await Promise.all([refreshIntelligence(), refreshMemory()]);
      toast(`${ids.length} memory proposal${ids.length === 1 ? "" : "s"} approved.`);
    } catch (error) { toast(error.message, "error"); }
  });
  elements.think.addEventListener("change", () => {
    app.settings.think = elements.think.value;
    persistAiSettings();
  });
  elements.mode.addEventListener("change", () => {
    const requestedMode = elements.mode.value;
    elements.mode.value = app.settings.mode;
    explainMode(requestedMode);
  });
  elements.temperature.addEventListener("input", () => {
    elements.temperatureValue.value = elements.temperature.value;
    app.settings.temperature = Number(elements.temperature.value);
    persistAiSettings();
  });
  elements.contextSize.addEventListener("change", () => {
    app.settings.numCtx = Number(elements.contextSize.value);
    persistAiSettings();
  });
  elements.maxTokens.addEventListener("change", () => {
    app.settings.maxTokens = Number(elements.maxTokens.value);
    persistAiSettings();
  });
  elements.liveListenButton.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    elements.liveListenButton.setPointerCapture?.(event.pointerId);
    startPushToTalk().catch(() => {});
  });
  const releasePushToTalk = (event) => {
    event?.preventDefault();
    stopPushToTalk().catch(() => {});
  };
  elements.liveListenButton.addEventListener("pointerup", releasePushToTalk);
  elements.liveListenButton.addEventListener("pointercancel", releasePushToTalk);
  elements.liveListenButton.addEventListener("lostpointercapture", releasePushToTalk);
  elements.liveListenButton.addEventListener("keydown", (event) => {
    if (![" ", "Enter"].includes(event.key) || event.repeat) return;
    event.preventDefault();
    startPushToTalk().catch(() => {});
  });
  elements.liveListenButton.addEventListener("keyup", (event) => {
    if (![" ", "Enter"].includes(event.key)) return;
    releasePushToTalk(event);
  });
  elements.liveListenButton.addEventListener("blur", releasePushToTalk);
  elements.liveListenButton.addEventListener("click", (event) => event.preventDefault());
  elements.chooseWhisperFolder.addEventListener("click", async () => {
    try {
      app.desktopVoice.status = await window.evolvDesktopVoice.chooseWhisperFolder();
      renderDesktopVoiceStatus();
    } catch (error) { toast(`Whisper: ${error.message}`, "error"); }
  });
  elements.chooseWhisperModel.addEventListener("click", async () => {
    try {
      app.desktopVoice.status = await window.evolvDesktopVoice.chooseWhisperModel();
      renderDesktopVoiceStatus();
      toast("Whisper speech model selected.");
    } catch (error) { toast(`Whisper model: ${error.message}`, "error"); }
  });
  elements.downloadWhisperModels.addEventListener("click", async () => {
    try { await window.evolvDesktopVoice.openWhisperDownloads(); }
    catch (error) { toast(`Whisper downloads: ${error.message}`, "error"); }
  });
  elements.hearingAccuracy.addEventListener("change", () => {
    app.settings.hearingAccuracy = elements.hearingAccuracy.value === "fast" ? "fast" : "enhanced";
    saveLocal();
  });
  elements.hearingReviewMode.addEventListener("change", () => {
    app.settings.hearingReviewMode = elements.hearingReviewMode.value === "always" ? "always" : "uncertain";
    saveLocal();
  });
  elements.hearingVocabulary.addEventListener("change", () => {
    app.settings.hearingVocabulary = elements.hearingVocabulary.value.slice(0, 1200);
    saveLocal();
    toast("Personal hearing vocabulary saved on this device.");
  });
  elements.choosePiperRuntime.addEventListener("click", async () => {
    try {
      app.desktopVoice.status = await window.evolvDesktopVoice.choosePiperRuntime();
      renderDesktopVoiceStatus();
    } catch (error) { toast(`Piper: ${error.message}`, "error"); }
  });
  elements.choosePiperModel.addEventListener("click", async () => {
    try {
      app.desktopVoice.status = await window.evolvDesktopVoice.choosePiperModel();
      renderDesktopVoiceStatus();
    } catch (error) { toast(`Piper: ${error.message}`, "error"); }
  });
  elements.downloadPiperModels.addEventListener("click", async () => {
    try {
      await window.evolvDesktopVoice.openModelDownloads();
    } catch (error) { toast(`Voice downloads: ${error.message}`, "error"); }
  });
  elements.voiceToggle.addEventListener("click", () => {
    app.settings.autoSpeak = !app.settings.autoSpeak;
    elements.voiceToggle.classList.toggle("active", app.settings.autoSpeak);
    elements.voiceToggle.title = app.settings.autoSpeak ? "Spoken replies on" : "Spoken replies off";
    if (!app.settings.autoSpeak) stopSpeech();
    saveLocal();
    toast(app.settings.autoSpeak ? "Spoken replies enabled." : "Spoken replies disabled.");
  });
  elements.voiceSelect.addEventListener("change", () => {
    app.settings.voiceURI = elements.voiceSelect.value;
    saveLocal();
  });
  elements.voiceRate.addEventListener("input", () => {
    app.settings.voiceRate = Number(elements.voiceRate.value);
    elements.voiceRateValue.value = `${app.settings.voiceRate.toFixed(1)}×`;
    saveLocal();
  });
  elements.gestureButton.addEventListener("click", () => elements.gestureDialog.showModal());
  elements.cameraToggle.addEventListener("click", () => {
    if (app.cameraStream) stopCamera();
    else startCamera();
  });
  $("#gesture-close").addEventListener("click", closeGesturePanel);
  elements.gestureDialog.addEventListener("close", stopCamera);
  $("#settings-button").addEventListener("click", () => {
    elements.settings.showModal();
    refreshDesktopUpdateStatus({ silent: true });
  });
  $("#change-password-button").addEventListener("click", () => {
    elements.settings.close();
    elements.passwordError.classList.add("hidden");
    elements.passwordError.textContent = "";
    elements.passwordForm.reset();
    elements.passwordDialog.showModal();
    $("#current-password").focus();
  });
  $("#password-dialog-close").addEventListener("click", () => elements.passwordDialog.close());
  elements.desktopUpdateCheck?.addEventListener("click", () => refreshDesktopUpdateStatus({ check: true }));
  elements.desktopUpdateInstall?.addEventListener("click", async () => {
    const button = elements.desktopUpdateInstall;
    button.disabled = true;
    try {
      let status = await window.evolvDesktopApp.updateStatus();
      if (!status.readyToInstall) {
        renderDesktopUpdateStatus({ ...status, phase: "downloading" });
        status = await window.evolvDesktopApp.downloadUpdate();
        renderDesktopUpdateStatus(status);
      }
      renderDesktopUpdateStatus({ ...status, phase: "installing" });
      await window.evolvDesktopApp.installUpdate();
    } catch (error) {
      toast(`Update failed: ${error.message}`, "error");
      await refreshDesktopUpdateStatus({ silent: true });
    } finally {
      button.disabled = false;
    }
  });
  elements.passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = elements.passwordForm.querySelector("button[type=submit]");
    submit.disabled = true;
    elements.passwordError.classList.add("hidden");
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: $("#current-password").value,
          newPassword: $("#new-password").value,
          confirmPassword: $("#confirm-new-password").value
        })
      });
      window.location.replace("/login.html");
    } catch (error) {
      elements.passwordError.textContent = error.message;
      elements.passwordError.classList.remove("hidden");
    } finally {
      submit.disabled = false;
    }
  });
  $("#lock-button").addEventListener("click", lockEvolv);
  $("#logout-button").addEventListener("click", lockEvolv);
  $("#new-chat").addEventListener("click", () => startNewChat().catch((error) => toast(error.message, "error")));
  let conversationSearchTimer;
  elements.conversationSearch.addEventListener("input", () => {
    clearTimeout(conversationSearchTimer);
    conversationSearchTimer = setTimeout(() => refreshConversations().catch((error) => toast(error.message, "error")), 250);
  });
  elements.conversationFilter.addEventListener("change", () => {
    refreshConversations().catch((error) => toast(error.message, "error"));
  });
  elements.toolsMaster.addEventListener("change", async () => {
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ toolsEnabled: elements.toolsMaster.checked })
      });
      toast(elements.toolsMaster.checked ? "Tools enabled." : "Tools disabled.");
    } catch (error) {
      elements.toolsMaster.checked = !elements.toolsMaster.checked;
      toast(error.message, "error");
    }
  });
  $("#obsidian-connect")?.addEventListener("click", async () => {
    try {
      if (!window.evolvObsidian?.chooseVault) throw new Error("Open the Evolv desktop app to connect a live Obsidian vault.");
      const selection = await window.evolvObsidian.chooseVault();
      if (!selection?.grant) return;
      await api("/api/obsidian/connect", { method: "POST", body: JSON.stringify({ grant: selection.grant }) });
      await Promise.all([refreshObsidian(), refreshMemory()]);
      toast(`Connected ${selection.label || "Obsidian vault"}.`);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#obsidian-sync")?.addEventListener("click", async () => {
    try {
      await api("/api/obsidian/sync", { method: "POST", body: "{}" });
      await refreshObsidian();
      toast("Obsidian vault synchronized.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#obsidian-open")?.addEventListener("click", async () => {
    try { await api("/api/obsidian/open", { method: "POST", body: "{}" }); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#obsidian-disconnect")?.addEventListener("click", async () => {
    if (!window.confirm("Disconnect this profile from its Obsidian vault? Notes will not be deleted.")) return;
    try {
      await api("/api/obsidian/connection", { method: "DELETE" });
      await refreshObsidian();
      toast("Obsidian disconnected. Existing notes were left untouched.");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#obsidian-changes")?.addEventListener("click", (event) => {
    const button = event.target.closest(".vault-change-decision");
    const undo = event.target.closest(".vault-change-undo");
    const card = (button || undo)?.closest(".vault-change-card");
    if (!card) return;
    if (button) decideVaultChange(card, button.dataset.decision).catch((error) => toast(error.message, "error"));
    if (undo) api(`/api/obsidian/changes/${encodeURIComponent(card.dataset.changeId)}/undo`, {
      method: "POST", body: "{}"
    }).then(() => Promise.all([refreshObsidian(), refreshMemory()]))
      .then(() => toast("Obsidian change undone."))
      .catch((error) => toast(error.message, "error"));
  });
  let obsidianSearchTimer;
  $("#obsidian-note-search")?.addEventListener("input", () => {
    clearTimeout(obsidianSearchTimer);
    obsidianSearchTimer = setTimeout(() => searchObsidianNotes().catch((error) => toast(error.message, "error")), 250);
  });
  $("#obsidian-note-results")?.addEventListener("click", async (event) => {
    const button = event.target.closest(".open-vault-search-note");
    if (!button) return;
    try { await api(`/api/obsidian/open/${encodeURIComponent(button.dataset.noteId)}`, { method: "POST", body: "{}" }); }
    catch (error) { toast(error.message, "error"); }
  });
  $("#tool-recipe-generate")?.addEventListener("click", async () => {
    const request = $("#tool-recipe-request").value.trim();
    if (!request) return toast("Describe the tool you want to generate.", "error");
    const recipeModel = $("#tool-recipe-model").value;
    if (!recipeModel) return toast("Choose a specific model to generate a recipe.", "error");
    const button = $("#tool-recipe-generate");
    button.disabled = true;
    button.textContent = "Generating recipe...";
    try {
      await api("/api/tool-recipes/generate", {
        method: "POST",
        body: JSON.stringify({ request, provider: app.settings.provider, model: recipeModel })
      });
      $("#tool-recipe-request").value = "";
      await refreshToolRecipes();
      toast("Recipe generated. Review every step before installation.");
    } catch (error) { toast(error.message, "error"); }
    finally {
      button.disabled = false;
      button.textContent = "Generate safe recipe";
    }
  });
  $("#tool-recipe-proposals")?.addEventListener("click", async (event) => {
    const card = event.target.closest(".recipe-proposal");
    if (!card) return;
    try {
      if (event.target.closest(".recipe-dry-run-button")) {
        await saveRecipeEditor(card);
        const result = await api(`/api/tool-recipes/${encodeURIComponent(card.dataset.recipeId)}/test`, { method: "POST", body: "{}" });
        card.querySelector(".recipe-dry-run").innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
        toast("Recipe is valid. No tools were executed.");
      }
      const decisionButton = event.target.closest(".recipe-decision");
      if (decisionButton) {
        if (decisionButton.dataset.decision === "approved") await saveRecipeEditor(card);
        const result = await api(`/api/tool-recipes/${encodeURIComponent(card.dataset.recipeId)}/decision`, {
          method: "POST", body: JSON.stringify({ decision: decisionButton.dataset.decision })
        });
        await Promise.all([refreshToolRecipes(), refreshMacros(), refreshObsidian(), refreshTools()]);
        toast(result.macro ? `macro_${result.macro.name} installed.` : "Generated recipe rejected.");
      }
    } catch (error) { toast(error.message, "error"); }
  });
  elements.attachButton?.addEventListener("click", () => elements.attachInput.click());
  elements.attachInput?.addEventListener("change", async () => {
    await addAttachments([...elements.attachInput.files]);
    elements.attachInput.value = "";
  });
  elements.backupButton?.addEventListener("click", async () => {
    try {
      const backup = await api("/api/backups", { method: "POST" });
      toast(`Backup created: ${backup.file}`);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  elements.exportButton?.addEventListener("click", async () => {
    try {
      const exported = await api("/api/export");
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `evolv-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      toast("Export downloaded.");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  elements.importButton?.addEventListener("click", () => elements.importInput.click());
  elements.importInput?.addEventListener("change", async () => {
    const file = elements.importInput.files[0];
    elements.importInput.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const preview = await api("/api/import/preview", { method: "POST", body: JSON.stringify(payload) });
      app.pendingImport = payload;
      elements.importSummary.textContent =
        `This file contains ${preview.counts.conversations} conversations, ${preview.counts.versions} prompt versions, and ${preview.counts.knowledge} knowledge records. Import merges without deleting existing data.`;
      elements.importPreview.classList.remove("hidden");
    } catch (error) {
      app.pendingImport = null;
      toast(error.message.includes("Unsupported") ? error.message : "That file is not a valid Evolv export.", "error");
    }
  });
  elements.importConfirm?.addEventListener("click", async () => {
    if (!app.pendingImport) return;
    try {
      const result = await api("/api/import/commit", { method: "POST", body: JSON.stringify(app.pendingImport) });
      elements.importPreview.classList.add("hidden");
      app.pendingImport = null;
      toast(`Import complete: ${result.counts.conversations} conversations, ${result.counts.knowledge} knowledge records.`);
      await Promise.all([refreshConversations(), refreshState()]);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  elements.importCancel?.addEventListener("click", () => {
    app.pendingImport = null;
    elements.importPreview.classList.add("hidden");
  });
  $("#mode-dialog-close").addEventListener("click", closeModeDialog);
  $("#mode-cancel").addEventListener("click", closeModeDialog);
  $("#mode-confirm").addEventListener("click", confirmMode);
  elements.modeDialog.addEventListener("close", () => {
    app.pendingMode = null;
    app.pendingModeAction = null;
    elements.mode.value = app.settings.mode;
  });
  $$(".mode-guide-card").forEach((button) => button.addEventListener("click", () => {
    explainMode(button.dataset.modeChoice);
  }));
  $("#knowledge-form").addEventListener("submit", saveKnowledge);
  $("#memory-form").addEventListener("submit", saveMemory);
  $("#memory-extract").addEventListener("click", extractMemoryFromChat);
  $("#vault-export").addEventListener("click", exportVault);
  $("#vault-import").addEventListener("click", () => $("#vault-input").click());
  $("#vault-input").addEventListener("change", async (event) => {
    await importVault(event.target.files);
    event.target.value = "";
  });
  $("#architecture-form").addEventListener("submit", designArchitecture);
  $("#spark-button").addEventListener("click", () => {
    explainMode("creative", () => {
      switchView("chat");
      sendMessage("Create one surprising, original idea by connecting two unrelated domains. Make it useful, explain the connection briefly, and clearly label any speculation.");
    });
  });
  let marketplaceSearchTimer;
  const refreshMarketplaceFromControls = () => {
    clearTimeout(marketplaceSearchTimer);
    marketplaceSearchTimer = setTimeout(() => refreshMarketplace({ preserveDetails: false }).catch((error) => toast(error.message, "error")), 180);
  };
  $("#marketplace-search")?.addEventListener("input", refreshMarketplaceFromControls);
  $("#marketplace-search")?.addEventListener("change", () => {
    const query = $("#marketplace-search").value.trim();
    if (query) {
      const recent = [query, ...loadJson("evolv:marketplace-searches", []).filter((item) => item !== query)].slice(0, 8);
      localStorage.setItem("evolv:marketplace-searches", JSON.stringify(recent));
    }
    refreshMarketplaceFromControls();
  });
  for (const selector of ["#marketplace-category", "#marketplace-filter", "#marketplace-sort", "#marketplace-os"]) {
    $(selector)?.addEventListener("change", refreshMarketplaceFromControls);
  }
  $("#marketplace-model-filter")?.addEventListener("input", refreshMarketplaceFromControls);
  $("#marketplace-clear")?.addEventListener("click", () => {
    $("#marketplace-search").value = "";
    $("#marketplace-category").value = "";
    $("#marketplace-filter").value = "";
    $("#marketplace-sort").value = "featured";
    $("#marketplace-os").value = "";
    $("#marketplace-model-filter").value = "";
    refreshMarketplace({ preserveDetails: false }).catch((error) => toast(error.message, "error"));
  });
  $$(".marketplace-tab").forEach((button) => button.addEventListener("click", () => {
    app.marketplaceTab = button.dataset.marketplaceTab;
    refreshMarketplace({ preserveDetails: false }).catch((error) => toast(error.message, "error"));
  }));
  $(".marketplace-tabs")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = $$(".marketplace-tab");
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });
  $("#marketplace-grid")?.addEventListener("click", (event) => {
    const packChat = event.target.closest(".marketplace-chat-pack");
    if (packChat) return activatePackChat(packChat).catch((error) => toast(error.message, "error"));
    const command = event.target.closest(".marketplace-run-command");
    if (command) return activatePackCommand(command);
    const card = event.target.closest("[data-pack-id]");
    if (card) openMarketplaceDetails(card.dataset.packId);
  });
  $("#marketplace-grid")?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const card = event.target.closest(".marketplace-card");
    if (card) { event.preventDefault(); openMarketplaceDetails(card.dataset.packId); }
  });
  $("#marketplace-details")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.classList.contains("marketplace-chat-pack")) {
        await activatePackChat(button);
      } else if (button.classList.contains("marketplace-install") || button.classList.contains("marketplace-update")) {
        await beginMarketplaceInstall({ id: button.dataset.packId, ...(button.dataset.version ? { version: button.dataset.version } : {}) });
      } else if (button.classList.contains("marketplace-toggle")) {
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}`, {
          method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled === "true" })
        });
        await refreshMarketplace();
      } else if (button.classList.contains("marketplace-configure")) {
        await openMarketplaceConfig(button.dataset.packId);
      } else if (button.classList.contains("marketplace-dev-watch-start")) {
        const result = await api(`/api/marketplace/dev-watch/${encodeURIComponent(button.dataset.packId)}`, { method: "PUT", body: "{}" });
        if (!result.canceled) toast(`Validated live reload started for ${result.sourceName}.`);
        await refreshMarketplace();
      } else if (button.classList.contains("marketplace-dev-watch-stop")) {
        await api(`/api/marketplace/dev-watch/${encodeURIComponent(button.dataset.packId)}`, { method: "DELETE", body: "{}" });
        toast("Pack live reload stopped.");
        await refreshMarketplace();
      } else if (button.classList.contains("marketplace-review-sync")) {
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}/reviews/sync`, { method: "POST", body: "{}" });
        toast("Signed reviews refreshed.");
        await openMarketplaceDetails(button.dataset.packId);
      } else if (button.classList.contains("marketplace-export")) {
        const payload = await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}/export`);
        downloadJsonFile(payload, `${button.dataset.packId}-${payload.manifest.version}.evolvpack`);
        toast("Pack exported.");
      } else if (button.classList.contains("marketplace-uninstall")) {
        if (!window.confirm("Uninstall this pack? Its commands will be removed. Your project files are never deleted.")) return;
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}`, { method: "DELETE", body: "{}" });
        app.marketplaceSelectedId = "";
        $("#marketplace-details").innerHTML = '<div class="empty-panel"><div class="empty-glyph">▦</div><h2>Pack uninstalled</h2><p>Its commands and agent are no longer registered.</p></div>';
        await refreshMarketplace({ preserveDetails: false });
      } else if (button.classList.contains("marketplace-repair")) {
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}/repair`, { method: "POST", body: "{}" });
        toast("Pack registration repaired.");
        await openMarketplaceDetails(button.dataset.packId);
      } else if (button.classList.contains("marketplace-copy-diagnostics")) {
        await copyText(button.closest("details").querySelector("pre").textContent, null, { label: "Diagnostics copied." });
      } else if (button.classList.contains("marketplace-export-diagnostics")) {
        const details = await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}`);
        downloadJsonFile(details.diagnostics, `${button.dataset.packId}-diagnostics.json`);
        toast("Diagnostics exported.");
      } else if (button.classList.contains("marketplace-open-directory")) {
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}/open`, { method: "POST", body: "{}" });
      } else if (button.classList.contains("marketplace-run-command")) {
        activatePackCommand(button);
      } else if (button.classList.contains("marketplace-revoke")) {
        if (!window.confirm(`Revoke ${button.dataset.permission}? Required permission revocation disables the pack.`)) return;
        await api(`/api/marketplace/packs/${encodeURIComponent(button.dataset.packId)}/permission`, {
          method: "DELETE", body: JSON.stringify({ permission: button.dataset.permission })
        });
        await refreshMarketplace();
      }
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-details")?.addEventListener("change", async (event) => {
    const select = event.target.closest(".marketplace-channel-select");
    if (!select) return;
    try {
      await api(`/api/marketplace/packs/${encodeURIComponent(select.dataset.packId)}/channel`, {
        method: "PATCH", body: JSON.stringify({ channel: select.value })
      });
      toast(`Update channel changed to ${select.value}.`);
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); await openMarketplaceDetails(select.dataset.packId); }
  });
  $("#marketplace-details")?.addEventListener("submit", async (event) => {
    const form = event.target.closest(".marketplace-review-form");
    if (!form) return;
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form));
    try {
      const result = await api(`/api/marketplace/packs/${encodeURIComponent(form.dataset.packId)}/reviews`, {
        method: "POST", body: JSON.stringify(payload)
      });
      toast(result.status === "sent" ? "Review accepted by the signed backend." : "Review saved in the local outbox; it has not been published.");
      await openMarketplaceDetails(form.dataset.packId);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-permission-form")?.addEventListener("submit", confirmMarketplaceInstall);
  // Keep an explicit click path as well as form submission. This avoids a
  // Chromium dialog edge case where clicking the default submitter after a
  // scroll does not dispatch the form's submit event.
  $("#marketplace-permission-confirm")?.addEventListener("click", (event) => {
    event.preventDefault();
    confirmMarketplaceInstall(event).catch((error) => toast(error.message, "error"));
  });
  $("#marketplace-permission-select-optional")?.addEventListener("click", () => {
    $$("#marketplace-permission-list input[type=\"checkbox\"]:not(:disabled)").forEach((input) => { input.checked = true; });
  });
  $("#marketplace-permission-clear-optional")?.addEventListener("click", () => {
    $$("#marketplace-permission-list input[type=\"checkbox\"]:not(:disabled)").forEach((input) => { input.checked = false; });
  });
  $$("[data-marketplace-close]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.marketplaceClose;
    if (target === "config" && $("#marketplace-config-dialog").dataset.dirty === "true"
      && !window.confirm("Discard unsaved pack configuration changes?")) return;
    closeMarketplaceDialog(target);
    if (target === "permissions") app.pendingMarketplaceInstall = null;
  }));
  $("#marketplace-config-fields")?.addEventListener("input", () => {
    $("#marketplace-config-dialog").dataset.dirty = "true";
  });
  $("#marketplace-config-fields")?.addEventListener("click", async (event) => {
    const button = event.target.closest(".marketplace-config-picker");
    if (!button) return;
    const dialog = $("#marketplace-config-dialog");
    try {
      const result = await api(`/api/marketplace/packs/${encodeURIComponent(dialog.dataset.packId)}/picker`, {
        method: "POST", body: JSON.stringify({ key: button.dataset.key })
      });
      if (!result.canceled && result.path) {
        const input = $(`#marketplace-config-${CSS.escape(button.dataset.key)}`);
        input.value = result.path;
        dialog.dataset.dirty = "true";
      }
    } catch (error) { toast(error.message, "error"); }
  });
  for (const name of ["permissions", "config", "starter"]) {
    const dialog = marketplaceDialogByName(name);
    dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (name === "config" && dialog.dataset.dirty === "true"
        && !window.confirm("Discard unsaved pack configuration changes?")) return;
      closeMarketplaceDialog(name);
      if (name === "permissions") app.pendingMarketplaceInstall = null;
    });
    dialog?.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      closeMarketplaceDialog(name);
      if (name === "permissions") app.pendingMarketplaceInstall = null;
    });
    dialog?.addEventListener("close", () => {
      const target = app.marketplaceDialogReturnFocus;
      app.marketplaceDialogReturnFocus = null;
      if (target?.isConnected) target.focus();
    });
  }
  const saveMarketplaceConfig = async (event) => {
    event?.preventDefault();
    if (app.marketplaceConfigSaveInFlight) return;
    const id = $("#marketplace-config-dialog").dataset.packId;
    const button = $("#marketplace-config-confirm");
    const errorOutput = $("#marketplace-config-error");
    app.marketplaceConfigSaveInFlight = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Savingâ€¦";
    errorOutput.classList.add("hidden");
    try {
      await api(`/api/marketplace/packs/${encodeURIComponent(id)}/config`, {
        method: "PUT", body: JSON.stringify({ config: collectMarketplaceConfig() })
      });
      closeMarketplaceDialog("config");
      $("#marketplace-config-dialog").dataset.dirty = "false";
      toast("Pack configuration saved.");
      await refreshMarketplace();
    } catch (error) {
      errorOutput.textContent = error.message;
      errorOutput.classList.remove("hidden");
    } finally {
      app.marketplaceConfigSaveInFlight = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Save configuration";
    }
  };
  $("#marketplace-config-form")?.addEventListener("submit", saveMarketplaceConfig);
  $("#marketplace-config-confirm")?.addEventListener("click", (event) => {
    event.preventDefault();
    saveMarketplaceConfig(event).catch((error) => toast(error.message, "error"));
  });
  $("#marketplace-dialog-backdrop")?.addEventListener("click", () => {
    const dialog = marketplaceDialogs().find((item) => item.open || item.hasAttribute("open"));
    if (!dialog) return;
    const name = dialog.id.includes("permission") ? "permissions" : dialog.id.includes("config") ? "config" : "starter";
    if (name === "config" && dialog.dataset.dirty === "true"
      && !window.confirm("Discard unsaved pack configuration changes?")) return;
    closeMarketplaceDialog(name);
    if (name === "permissions") app.pendingMarketplaceInstall = null;
  });
  $("#marketplace-config-reset")?.addEventListener("click", async () => {
    const id = $("#marketplace-config-dialog").dataset.packId;
    try {
      await api(`/api/marketplace/packs/${encodeURIComponent(id)}/config`, { method: "DELETE", body: "{}" });
      closeMarketplaceDialog("config");
      $("#marketplace-config-dialog").dataset.dirty = "false";
      toast("Pack configuration reset.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); }
  });
  const setMarketplaceDeveloperMode = async (event) => {
    try {
      const result = await api("/api/marketplace/settings", { method: "PATCH", body: JSON.stringify({ developerMode: event.target.checked }) });
      $("#marketplace-developer-mode").checked = result.developerMode;
      $("#marketplace-developer-mode-settings").checked = result.developerMode;
      $("#marketplace-developer-panel").classList.toggle("hidden", !result.developerMode);
      toast(`Marketplace Developer Mode ${result.developerMode ? "enabled" : "disabled"}.`);
    } catch (error) { event.target.checked = !event.target.checked; toast(error.message, "error"); }
  };
  $("#marketplace-developer-mode")?.addEventListener("change", setMarketplaceDeveloperMode);
  $("#marketplace-developer-mode-settings")?.addEventListener("change", setMarketplaceDeveloperMode);
  $("#marketplace-import")?.addEventListener("click", () => $("#marketplace-file").click());
  $("#marketplace-file")?.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const output = $("#marketplace-validation-output");
    output.classList.remove("hidden");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("The .evolvpack file is too large.");
      const localPackage = JSON.parse(await file.text());
      const preview = await api("/api/marketplace/validate", { method: "POST", body: JSON.stringify({ package: localPackage }) });
      output.textContent = JSON.stringify({ valid: true, id: preview.manifest.id, version: preview.manifest.version, permissions: preview.permissions }, null, 2);
      await beginMarketplaceInstall({ package: localPackage });
    } catch (error) {
      output.textContent = `Validation failed\n${error.message}`;
      toast(error.message, "error");
    }
  });
  $("#marketplace-create")?.addEventListener("click", () => showMarketplaceDialog("starter"));
  $("#marketplace-catalog-connect")?.addEventListener("click", async () => {
    try {
      await api("/api/marketplace/catalog", {
        method: "PUT", body: JSON.stringify({ url: $("#marketplace-catalog-url").value.trim() })
      });
      await api("/api/marketplace/catalog/sync", { method: "POST", body: "{}" });
      toast("Signed remote catalog verified and cached.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); await refreshMarketplace(); }
  });
  $("#marketplace-catalog-sync")?.addEventListener("click", async () => {
    try {
      await api("/api/marketplace/catalog/sync", { method: "POST", body: "{}" });
      toast("Remote catalog synchronized.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); await refreshMarketplace(); }
  });
  $("#marketplace-catalog-disconnect")?.addEventListener("click", async () => {
    try {
      await api("/api/marketplace/catalog", { method: "DELETE", body: "{}" });
      toast("Remote catalog disconnected. Installed packs were kept.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-review-connect")?.addEventListener("click", async () => {
    try {
      await api("/api/marketplace/reviews/backend", {
        method: "PUT",
        body: JSON.stringify({
          url: $("#marketplace-review-url").value.trim(),
          publisherKeyId: $("#marketplace-review-key").value
        })
      });
      toast("Trusted review service saved.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-review-flush")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/marketplace/reviews/outbox/flush", { method: "POST", body: "{}" });
      toast(`Processed ${result.processed} pending review${result.processed === 1 ? "" : "s"}.`);
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-review-disconnect")?.addEventListener("click", async () => {
    try {
      await api("/api/marketplace/reviews/backend", { method: "DELETE", body: "{}" });
      toast("Review service disconnected. Local outbox entries were kept.");
      await refreshMarketplace();
    } catch (error) { toast(error.message, "error"); }
  });
  $("#marketplace-starter-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = { ...Object.fromEntries(formData), permissions: formData.getAll("permissions") };
    try {
      const starter = await api("/api/marketplace/starter", { method: "POST", body: JSON.stringify(payload) });
      downloadJsonFile(starter, `${starter.manifest.id}-${starter.manifest.version}.evolvpack`);
      closeMarketplaceDialog("starter");
      event.currentTarget.reset();
      toast("Starter .evolvpack generated.");
    } catch (error) { toast(error.message, "error"); }
  });
  elements.installButton?.addEventListener("click", () => {
    elements.installError.classList.add("hidden");
    attachToInstall();
  });
  elements.installCancel?.addEventListener("click", async () => {
    try {
      await api("/api/ollama/install-evolv/cancel", { method: "POST", body: "{}" });
    } catch (error) {
      toast(error.message, "error");
    }
  });
  elements.installHide?.addEventListener("click", () => {
    // Hides the panel, not the download: the run lives on the server and keeps
    // going, and the next refresh finds it again.
    app.dismissedLocalSetup = true;
    elements.localSetup.classList.add("hidden");
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      switchView("marketplace");
      $("#marketplace-search")?.focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      startNewChat().catch((error) => toast(error.message, "error"));
      return;
    }
    // Escape backs out of whatever is in progress, nearest first: the command
    // menu, then an edit, then a running generation.
    if (event.key === "Escape") {
      if (!elements.commandMenu?.classList.contains("hidden")) return hideCommandMenu();
      if (cancelEditing()) return;
      if (app.generating) elements.stop.click();
    }
  });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".starter").forEach((button) => button.addEventListener("click", () => sendMessage(button.textContent)));
  elements.propose.addEventListener("click", proposeUpgrade);
  $("#evaluate-proposal")?.addEventListener("click", evaluateProposal);
  $("#reject-proposal").addEventListener("click", async () => {
    try {
      await api("/api/proposals/current", { method: "DELETE" });
      await refreshState();
      toast("Proposal discarded.");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#apply-proposal").addEventListener("click", async () => {
    try {
      await api("/api/proposals/apply", {
        method: "POST",
        body: JSON.stringify({ proposalId: app.state.pendingProposal.id })
      });
      await refreshState();
      switchView("versions");
      toast("Upgrade approved and activated.");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

init();
