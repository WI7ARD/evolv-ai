// The demo: Evolv running an experiment on itself, narrated, and recorded.
//
// Three things happen at once — the window is captured, Piper speaks the
// narration at 1.5x, and the script drives the real UI. None of it is faked:
// the physics is the same solver the sandbox uses, and the chat answer is
// generated live by whatever model is configured.
//
// Recording, conversion, and Piper are desktop-only. In a browser the demo
// still runs and still speaks, through the system voice, and says plainly that
// it cannot record rather than failing silently.

import { DEMO_SCRIPTS, pickScript } from "./demo-scripts.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, sendMessage: null, switchView: null,
  running: false, cancelled: false,
  recorder: null, chunks: [], stream: null, audio: null, mixer: null,
  names: new Map(), lastPath: ""
};

const NARRATION_RATE = 1.5;

// Status appears twice on purpose: on the demo panel, and on a floating
// indicator that survives the view switch. A demo that drives the physics view
// puts its own Stop button off-screen, which is exactly when it is wanted.
function status(text, { busy = false } = {}) {
  const line = $("#demo-status");
  if (line) line.textContent = text;
  const start = $("#demo-start");
  if (start) start.disabled = busy;
  $("#demo-stop")?.classList.toggle("hidden", !busy);
  $("#demo-hud")?.classList.toggle("hidden", !busy);
  const hudText = $("#demo-hud-text");
  if (hudText && busy) hudText.textContent = text;
}

function desktop() {
  return Boolean(window.evolvDemo && window.evolvDesktopVoice);
}

// ---------------------------------------------------------------- narration

// Piper returns a WAV. Playing it through an AudioContext rather than an
// <audio> element is what lets the same sound be fed to the recorder; an
// element's output cannot be captured without re-routing it anyway.
async function speak(line) {
  if (!line || state.cancelled) return;
  const piper = window.evolvDesktopVoice;
  if (piper?.synthesize) {
    try {
      const result = await piper.synthesize(line, { rate: NARRATION_RATE });
      if (result?.audioBase64) return playWav(result.audioBase64);
    } catch {
      // Piper missing or busy is not a reason to abandon the demo.
    }
  }
  return speakWithSystemVoice(line);
}

function playWav(base64) {
  return new Promise((resolve) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    state.audio.decodeAudioData(bytes.buffer, (buffer) => {
      const source = state.audio.createBufferSource();
      source.buffer = buffer;
      source.connect(state.audio.destination);
      if (state.mixer) source.connect(state.mixer);
      source.onended = resolve;
      source.start();
    }, () => resolve());
  });
}

function speakWithSystemVoice(line) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(line);
    utterance.rate = NARRATION_RATE;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    speechSynthesis.speak(utterance);
  });
}

// ---------------------------------------------------------------- recording

async function startRecording(title) {
  if (!desktop()) return false;
  try {
    const armed = await window.evolvDemo.arm();
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    state.stream = display;

    // Narration is mixed in as a track rather than relying on system audio
    // capture, which is unavailable on some platforms and would also pick up
    // whatever else the machine happens to be playing.
    state.audio = new AudioContext();
    state.mixer = state.audio.createMediaStreamDestination();
    state.mixer.stream.getAudioTracks().forEach((track) => display.addTrack(track));

    state.chunks = [];
    state.recorder = new MediaRecorder(display, { mimeType: "video/webm;codecs=vp9,opus" });
    state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
    state.recorder.start(1000);
    return { converter: armed?.converter !== false };
  } catch (error) {
    await window.evolvDemo.disarm().catch(() => {});
    state.toast(`Recording did not start: ${error.message}`, "error");
    state.stream = null;
    state.recorder = null;
    return false;
  }
}

async function finishRecording(title) {
  if (!state.recorder) {
    state.audio?.close().catch(() => {});
    state.audio = null;
    state.mixer = null;
    return null;
  }
  const stopped = new Promise((resolve) => { state.recorder.onstop = resolve; });
  state.recorder.stop();
  await stopped;
  state.stream?.getTracks().forEach((track) => track.stop());
  await window.evolvDemo.disarm().catch(() => {});

  const blob = new Blob(state.chunks, { type: "video/webm" });
  state.recorder = null;
  state.stream = null;
  await state.audio?.close().catch(() => {});
  state.audio = null;
  state.mixer = null;
  if (!blob.size) return null;

  status("Converting to MP4…", { busy: true });
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return await window.evolvDemo.save(Array.from(bytes), title);
  } catch (error) {
    state.toast(`The recording could not be saved: ${error.message}`, "error");
    return null;
  }
}

// ------------------------------------------------------------------ running

// "$ball" refers to whatever the step that declared `as: "ball"` created.
function resolve(value) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  return state.names.get(value.slice(1)) || value;
}

async function physics(actions = []) {
  for (const action of actions) {
    if (state.cancelled) return;
    const payload = { ...action };
    delete payload.as;
    if (payload.id) payload.id = resolve(payload.id);
    const result = await state.api("/api/physics/actions", { method: "POST", body: JSON.stringify(payload) });
    const created = result?.results?.[0];
    if (action.as && created?.id) state.names.set(action.as, created.id);
  }
}

async function runSteps(steps) {
  for (let index = 0; index < steps.length; index += 1) {
    if (state.cancelled) return;
    const step = steps[index];
    status(`Step ${index + 1} of ${steps.length}`, { busy: true });

    if (step.physics) await physics(step.physics);
    if (step.ask && state.sendMessage) {
      // Typed into the real composer so the recording shows it being asked.
      const prompt = $("#prompt");
      if (prompt) prompt.value = "";
      await state.sendMessage(step.prompt || "");
    }

    // The narration and the simulation advance together, so the clip is paced
    // by the sentence rather than by a delay someone guessed.
    const spoken = speak(step.say);
    if (step.run) await runPhysicsFor(step.run);
    await spoken;

    if (step.measure) await announce(step.measure);
  }
}

async function runPhysicsFor(totalSteps) {
  let done = 0;
  while (done < totalSteps && !state.cancelled) {
    const batch = Math.min(6, totalSteps - done);
    await state.api("/api/physics/step", { method: "POST", body: JSON.stringify({ steps: batch }) });
    done += batch;
    await new Promise((resolve) => setTimeout(resolve, 24));
  }
}

// The demo reads its own result rather than asserting one, so the number it
// says out loud is whatever actually happened.
async function announce(measure) {
  const scene = await state.api("/api/physics");
  if (measure.compare) {
    const [first, second] = measure.compare.map((name) => {
      const id = resolve(name);
      return scene.objects.find((object) => object.id === id);
    });
    if (!first || !second) return;
    const axis = measure.axis === "y" ? "y" : "x";
    const gap = Math.round(Math.abs(second[axis] - first[axis]));
    await speak(gap < 10
      ? `They finished within ${gap} pixels of each other.`
      : `The ice crate finished ${gap} pixels further along. Same shape, same slope, same gravity — the only thing that changed was friction.`);
    return;
  }
  if (measure.report === "settled") {
    await speak(scene.settled
      ? `Everything has come to rest. ${scene.objectCount} objects, all of them solved rather than animated.`
      : "Still moving. Every one of those collisions is being worked out as it happens.");
  }
}

export async function runDemo(id = "") {
  if (state.running) return;
  const script = pickScript(id);
  state.running = true;
  state.cancelled = false;
  state.names = new Map();
  const title = $("#demo-title");
  if (title) title.textContent = script.title;

  try {
    if (script.kind === "physics") state.switchView("physics");
    else state.switchView("chat");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const recording = await startRecording(script.title);
    if (!recording) {
      status(desktop() ? "Running without a recording." : "Running. Recording needs the desktop app.", { busy: true });
    } else {
      status("Recording…", { busy: true });
    }

    await runSteps(script.steps.map((step) => ({ ...step, prompt: script.prompt })));
    if (!state.cancelled) await speak("That was Evolv, running locally on this computer.");

    const saved = await finishRecording(script.title);
    if (saved?.path) {
      state.lastPath = saved.path;
      $("#demo-reveal")?.classList.remove("hidden");
      status(saved.converted
        ? `Saved ${saved.path}`
        : `Saved ${saved.path} — ${saved.reason || "kept as WebM."}`);
    } else {
      status(state.cancelled ? "Demo stopped." : "Demo finished.");
    }
  } catch (error) {
    state.toast(error.message, "error");
    await finishRecording(script.title).catch(() => {});
    status("Demo stopped.");
  } finally {
    state.running = false;
    status($("#demo-status")?.textContent || "Ready.", { busy: false });
  }
}

export function initDemo({ api, toast, sendMessage, switchView }) {
  state.api = api;
  state.toast = toast;
  state.sendMessage = sendMessage;
  state.switchView = switchView;

  const select = $("#demo-script");
  if (select) {
    select.innerHTML = '<option value="">Surprise me</option>'
      + DEMO_SCRIPTS.map((script) => `<option value="${script.id}">${script.title}</option>`).join("");
  }
  $("#demo-start")?.addEventListener("click", () => runDemo($("#demo-script")?.value || ""));
  const stopDemo = () => {
    state.cancelled = true;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    status("Stopping…", { busy: true });
  };
  $("#demo-stop")?.addEventListener("click", stopDemo);
  $("#demo-hud-stop")?.addEventListener("click", stopDemo);
  $("#demo-reveal")?.addEventListener("click", () => {
    if (state.lastPath) window.evolvDemo?.reveal(state.lastPath);
  });

  const note = $("#demo-note");
  if (note && !desktop()) {
    note.textContent = "This is the browser version. The demo will run and narrate, but recording to MP4 needs the desktop app.";
  }
}
