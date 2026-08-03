import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] || 9333);
const executable = process.argv[3] ? path.resolve(process.argv[3]) : "";
const smokeRoot = path.resolve(process.env.EVOLV_SMOKE_ROOT || "C:\\tmp");
let child = null;
let temporary = "";

function cleanup() {
  try { child?.kill(); } catch {}
  if (temporary) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
  }
}
process.once("exit", cleanup);

if (executable) {
  temporary = fs.mkdtempSync(path.join(smokeRoot, "evolv-packaged-smoke-"));
  child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    "--no-sandbox",
    `--user-data-dir=${path.join(temporary, "chromium")}`
  ], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EVOLV_DESKTOP_SMOKE: "1",
      EVOLV_DATA_DIR: path.join(temporary, "data")
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    child.kill();
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error("Packaged Electron app did not start.");
  }
}

// The first page target may still be navigating from / to the local login page.
await new Promise((resolve) => setTimeout(resolve, 1_500));
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target) throw new Error("No packaged renderer target was available.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Packaged renderer evaluation timed out.")), 10_000);
  socket.addEventListener("open", () => socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const bridge = typeof window.evolvDesktopVoice?.transcribe === "function";
        const status = bridge ? await window.evolvDesktopVoice.status() : null;
        let microphoneAccess = false;
        let transcript = "";
        let hearing = null;
        if (status?.recognition?.ready) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          microphoneAccess = stream.getAudioTracks().length > 0;
          stream.getTracks().forEach((track) => track.stop());
          const speech = await window.evolvDesktopVoice.synthesize("Build a profitable software product.", { rate: 0.9 });
          const binary = atob(speech.audioBase64);
          const audio = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) audio[index] = binary.charCodeAt(index);
          hearing = await window.evolvDesktopVoice.transcribe(audio, {
            vocabulary: ["Evolv", "software product"],
            contextPhrases: ["Build a profitable software product"],
            multiPass: true
          });
          transcript = hearing.text;
        }
        return {
          bridge,
          path: location.pathname,
          desktop: status?.desktop,
          whisperReady: status?.recognition?.ready,
          piperReady: status?.piper?.ready,
          microphoneAccess,
          transcript,
          confidence: hearing?.confidence,
          agreement: hearing?.agreement,
          needsReview: hearing?.needsReview,
          passes: hearing?.hearing?.passes,
          audioQuality: hearing?.audio?.quality
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    }
  })));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.result?.exceptionDetails) {
      reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text || "Renderer evaluation failed."));
      return;
    }
    if (!message.result?.result || message.result.result.type === "undefined") {
      reject(new Error(`Renderer returned no smoke-test value: ${JSON.stringify(message)}`));
      return;
    }
    resolve(message.result.result.value);
  });
  socket.addEventListener("error", reject);
});

socket.close();
console.log(JSON.stringify(result, null, 2));
const normalizedTranscript = String(result?.transcript || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
if (!result?.bridge || !result?.desktop || !result?.whisperReady || !result?.piperReady
  || !result?.microphoneAccess || normalizedTranscript !== "build a profitable software product"
  || result?.confidence < 0.9 || result?.agreement !== 1 || result?.needsReview || result?.passes !== 2
  || result?.audioQuality !== "good") {
  process.exitCode = 1;
}
if (child) {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
process.removeListener("exit", cleanup);
