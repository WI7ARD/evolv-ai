import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startMockOllama } from "../test/helpers/mock-ollama.mjs";

const executable = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 9361);
const smokeRoot = path.resolve(process.env.EVOLV_SMOKE_ROOT || process.cwd());
if (!executable || !fs.existsSync(executable)) throw new Error("Pass the packaged Evolv.exe path.");

const temporary = fs.mkdtempSync(path.join(smokeRoot, "evolv-agent-smoke-"));
const mock = await startMockOllama();
mock.setCapabilities(["completion"]);
mock.setScript(() => [{ content: JSON.stringify({
  verified: true,
  criteria: [{ criterion: "The restricted calculator returns four", met: true, evidence: "calculate returned 4" }],
  gaps: [], summary: "Verified from recorded tool evidence."
}) }]);

let child;
function launch() {
  child = spawn(executable, [`--remote-debugging-port=${port}`, "--no-sandbox", `--user-data-dir=${path.join(temporary, "chromium")}`], {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, OLLAMA_URL: mock.url, EVOLV_DESKTOP_SMOKE: "1", EVOLV_DATA_DIR: path.join(temporary, "data") }
  });
}
async function stop() {
  try { child?.kill(); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 600));
}
async function cleanup() {
  await stop();
  await mock.close().catch(() => {});
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
}
process.once("exit", () => { try { child?.kill(); } catch {} });

async function target() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const page = targets.find((item) => item.type === "page");
      if (page) return page;
    } catch {}
  }
  throw new Error("Packaged Agent renderer did not start.");
}

async function session() {
  const page = await target();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const socket = new WebSocket(page.webSocketDebuggerUrl);
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
    if (message.error || message.result?.exceptionDetails || message.result?.result?.subtype === "error") waiting.reject(new Error(
      message.error?.message ||
      message.result?.exceptionDetails?.exception?.description || message.result?.exceptionDetails?.text
      || message.result?.result?.description || "Renderer evaluation failed."
    ));
    else waiting.resolve(message.result?.result?.value ?? message.result?.value);
  });
  const evaluate = (expression, timeoutMs = 30_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Agent renderer evaluation timed out.")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  };
  return { socket, evaluate };
}

launch();
let first = await session();
const probe = await first.evaluate("1 + 1");
if (probe !== 2) throw new Error("Packaged renderer evaluation channel is unavailable.");
const result = await first.evaluate(`(async () => {
  const auth = await fetch('/api/auth/status', { cache: 'no-store' }).then((response) => response.json());
  const setupResponse = await fetch('/api/auth/setup', { method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({ setupNonce:auth.setupNonce, username:'owner', password:'packaged agent password', confirmPassword:'packaged agent password' }) });
  const setup = await setupResponse.json();
  if (!setupResponse.ok) throw new Error(setup.error || 'Setup failed');
  const headers = { 'content-type':'application/json', 'x-evolv-csrf':setup.csrfToken };
  const projects = await fetch('/api/projects').then((response) => response.json());
  const project = projects.projects[0];
  const createdResponse = await fetch('/api/agent-goals', { method:'POST', headers, body:JSON.stringify({
    objective:'Calculate two plus two and verify the evidence', successCriteria:['The restricted calculator returns four'],
    projectId:project.id, provider:'ollama', model:'mock-model',
    plan:{ summary:'Calculate then verify', steps:[
      { id:'calculate', title:'Calculate', description:'Use restricted arithmetic.', type:'tool', tool:'calculate', inputs:{ expression:'2+2' } },
      { id:'verify', title:'Verify', description:'Compare recorded evidence with the criterion.', type:'verification', dependencies:['calculate'] }
    ] }
  }) });
  const created = await createdResponse.json();
  if (!createdResponse.ok) throw new Error(created.error || 'Goal creation failed');
  const approvedResponse = await fetch('/api/runs/'+created.id+'/plan/approve', { method:'POST', headers, body:'{}' });
  if (!approvedResponse.ok) throw new Error((await approvedResponse.json()).error || 'Approval failed');
  const stream = await fetch('/api/runs/'+created.id+'/start', { method:'POST', headers, body:'{}' });
  const text = await stream.text();
  const events = text.trim().split(/\\n/).filter(Boolean).map(JSON.parse);
  const persisted = await fetch('/api/runs/'+created.id).then((response) => response.json());
  const smokeResult = { runId:created.id, state:persisted.state, goalStatus:persisted.goal?.status, steps:persisted.steps?.length,
    attempts:persisted.steps?.map((step)=>step.attemptsHistory?.length), evidence:persisted.evidence?.length,
    completion:events.at(-1)?.type, verified:events.at(-1)?.verified,
    horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth };
  setTimeout(() => location.assign('/'), 50);
  return smokeResult;
})()`, 45_000);
if (!result?.runId) throw new Error("Packaged Agent smoke did not return a durable run result.");
await new Promise((resolve) => setTimeout(resolve, 2_000));
Object.assign(result, await first.evaluate(`(() => {
  const nav = document.querySelector('[data-view="agent"]');
  nav?.click();
  return { agentVisible:document.querySelector('#agent-view')?.classList.contains('active'),
    horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth };
})()`));
first.socket.close();

await stop();
launch();
const second = await session();
const restarted = await second.evaluate(`(async () => {
  const status = await fetch('/api/auth/status').then((response) => response.json());
  const loginResponse = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({ username:'owner', password:'packaged agent password' }) });
  const login = await loginResponse.json();
  if (!loginResponse.ok) throw new Error(login.error || 'Restart login failed');
  const run = await fetch('/api/runs/${result.runId}').then((response) => response.json());
  return { lockedAfterRestart:!status.authenticated, state:run.state, goalStatus:run.goal?.status, evidence:run.evidence?.length };
})()`);
second.socket.close();

console.log(JSON.stringify({ ...result, restarted }, null, 2));
if (result.state !== "completed" || result.goalStatus !== "completed" || result.completion !== "completion" || !result.verified
  || !result.agentVisible || result.horizontalOverflow || result.steps !== 2 || result.evidence < 2
  || !result.attempts.every((count) => count === 1) || !restarted.lockedAfterRestart
  || restarted.state !== "completed" || restarted.goalStatus !== "completed") process.exitCode = 1;
await cleanup();
process.removeAllListeners("exit");
