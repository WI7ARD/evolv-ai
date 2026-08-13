import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const executable = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 9357);
const smokeRoot = path.resolve(process.env.EVOLV_SMOKE_ROOT || process.cwd());
if (!executable || !fs.existsSync(executable)) throw new Error("Pass the packaged Evolv.exe path.");

const temporary = fs.mkdtempSync(path.join(smokeRoot, "evolv-marketplace-smoke-"));
const child = spawn(executable, [`--remote-debugging-port=${port}`, "--no-sandbox", `--user-data-dir=${path.join(temporary, "chromium")}`], {
  windowsHide: true,
  stdio: "ignore",
  env: { ...process.env, EVOLV_DESKTOP_SMOKE: "1", EVOLV_DATA_DIR: path.join(temporary, "data") }
});
function cleanup() {
  try { child.kill(); } catch {}
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
}
process.once("exit", cleanup);

let ready = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    if (response.ok) { ready = true; break; }
  } catch {}
}
if (!ready) throw new Error("Packaged Electron app did not expose its clean-profile renderer.");
await new Promise((resolve) => setTimeout(resolve, 1_000));
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("No packaged renderer target was available.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  clearTimeout(waiting.timer);
  if (message.error) waiting.reject(new Error(message.error.message || "DevTools command failed."));
  else if (message.result?.exceptionDetails) waiting.reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
  else waiting.resolve(waiting.raw ? message.result : message.result?.result?.value);
});

function evaluate(expression, timeoutMs = 20_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Renderer evaluation timed out.")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
  });
}

function command(method, params = {}, timeoutMs = 20_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, raw: true });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const setup = await evaluate(`(async () => {
  const status = await fetch('/api/auth/status', { cache: 'no-store' }).then((response) => response.json());
  const response = await fetch('/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupNonce: status.setupNonce, password: 'stage seven verified password', confirmPassword: 'stage seven verified password' })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Setup failed');
  setTimeout(() => location.assign('/'), 50);
  return { configured: true, user: payload.user?.username || 'owner' };
})()`);
await new Promise((resolve) => setTimeout(resolve, 3_000));
await command("Emulation.setDeviceMetricsOverride", { width: 1365, height: 650, deviceScaleFactor: 1, mobile: false });
await new Promise((resolve) => setTimeout(resolve, 500));

await evaluate(`(() => {
  const prompt = document.querySelector('#prompt');
  prompt.value = '';
  prompt.focus();
  return document.activeElement === prompt;
})()`);
await command("Input.insertText", { text: "keyboard input works" });
const promptTyping = await evaluate(`document.querySelector('#prompt').value`);
const updateStatus = await evaluate(`window.evolvDesktopApp.updateStatus()`);

const result = await evaluate(`(async () => {
  const waitFor = async (read, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for Marketplace UI state.');
  };
  const nav = await waitFor(() => document.querySelector('[data-view="marketplace"]'));
  nav.click();
  const card = await waitFor(() => [...document.querySelectorAll('[data-pack-id]')]
    .find((item) => item.dataset.packId === 'evolv.autonomous-engineer'));
  card.click();
  const install = await waitFor(() => document.querySelector('#marketplace-details .marketplace-install'));
  install.click();
  const dialog = await waitFor(() => {
    const value = document.querySelector('#marketplace-permission-dialog');
    return value?.open ? value : null;
  }, 4000).catch(() => null);
  if (!dialog) {
    const auth = await fetch('/api/auth/status').then((response) => response.json());
    const previewResponse = await fetch('/api/marketplace/install/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-evolv-csrf': auth.csrfToken || '' },
      body: JSON.stringify({ id: 'evolv.autonomous-engineer' })
    });
    return {
      dialogOpened: false,
      previewStatus: previewResponse.status,
      previewPayload: await previewResponse.json(),
      toasts: [...document.querySelectorAll('.toast')].map((item) => item.textContent),
      viewActive: document.querySelector('#marketplace-view')?.classList.contains('active'),
      installDisabled: install.disabled,
      installConnected: install.isConnected,
      installClass: install.className,
      approvalTitle: document.querySelector('#marketplace-permission-title')?.textContent || '',
      permissionCount: document.querySelectorAll('#marketplace-permission-list input').length,
      dialogState: document.querySelector('#marketplace-permission-dialog')?.dataset.displayState || '',
      dialogOpenAttribute: document.querySelector('#marketplace-permission-dialog')?.hasAttribute('open')
    };
  }
  const approvalTitle = document.querySelector('#marketplace-permission-title')?.textContent || '';
  const confirm = document.querySelector('#marketplace-permission-confirm');
  if (!confirm || confirm.disabled) throw new Error('Pack approval button is unavailable.');
  confirm.click();
  const installed = await waitFor(async () => {
    const response = await fetch('/api/marketplace/packs/evolv.autonomous-engineer');
    const payload = await response.json();
    return payload.installedRecord?.enabled ? payload : null;
  });
  await waitFor(() => !dialog.open);
  await waitFor(() => document.querySelector('#marketplace-details .marketplace-chat-pack'));
  return {
    approvalTitle,
    installed: Boolean(installed.installedRecord),
    enabled: Boolean(installed.installedRecord?.enabled),
    version: installed.installedRecord?.version,
    dialogClosed: !dialog.open,
    chatReady: Boolean(document.querySelector('#marketplace-details .marketplace-chat-pack')),
    sidebarScrollable: document.querySelector('.sidebar').scrollHeight >= document.querySelector('.sidebar').clientHeight,
    conversationListUncapped: getComputedStyle(document.querySelector('#conversation-list')).maxHeight === 'none'
  };
})()`, 30_000);

const configOpened = await evaluate(`(async () => {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const button = document.querySelector('#marketplace-details .marketplace-configure');
    if (button) {
      button.click();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const dialog = document.querySelector('#marketplace-config-dialog');
  while (!dialog.open && Date.now() - start < 12000) await new Promise((resolve) => setTimeout(resolve, 100));
  const input = document.querySelector('#marketplace-config-maxPlanSteps');
  const actions = document.querySelector('#marketplace-config-form > .proposal-actions');
  input.focus();
  input.select();
  const rect = actions.getBoundingClientRect();
  return { open:dialog.open, focused:document.activeElement === input, topLayer:dialog.matches(':modal'),
    actionsVisible:rect.top >= 0 && rect.bottom <= innerHeight, actionBottom:Math.round(rect.bottom), viewportHeight:innerHeight };
})()`);
await command("Input.insertText", { text: "12" });
const configSaved = await evaluate(`(async () => {
  const dialog = document.querySelector('#marketplace-config-dialog');
  const button = document.querySelector('#marketplace-config-confirm');
  const typed = document.querySelector('#marketplace-config-maxPlanSteps').value;
  button.click();
  const start = Date.now();
  while (dialog.open && Date.now() - start < 12000) await new Promise((resolve) => setTimeout(resolve, 100));
  const pack = await fetch('/api/marketplace/packs/evolv.autonomous-engineer').then((response) => response.json());
  return { typed, closed:!dialog.open, saved:pack.installedRecord?.config?.maxPlanSteps };
})()`, 20_000);

console.log(JSON.stringify({ setup, promptTyping, updateStatus, ...result, configOpened, configSaved }, null, 2));
if (promptTyping !== "keyboard input works" || updateStatus?.currentVersion !== "0.6.3" || updateStatus?.repository !== "WI7ARD/evolv-ai"
  || !updateStatus?.supported || !result.installed || !result.enabled || !result.dialogClosed || !result.chatReady
  || !result.conversationListUncapped || !configOpened.open || !configOpened.focused || configOpened.topLayer || !configOpened.actionsVisible
  || configSaved.typed !== "12" || configSaved.saved !== 12 || !configSaved.closed) process.exitCode = 1;
socket.close();
cleanup();
process.removeListener("exit", cleanup);
