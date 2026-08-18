// The demo: Evolv running an experiment on itself, narrated.
//
// The script drives the real UI while Piper speaks the narration at 1.5x. None
// of it is faked: the physics is the same solver the sandbox uses, and the chat
// answer is generated live by whatever model is configured.
//
// Evolv does not record itself — that is left to whatever screen recorder the
// viewer already has, which works where the built-in one did not. Narration
// plays through the speakers, so it lands in the recording along with the
// picture.
//
// Piper is desktop-only. In a browser the demo still runs and still speaks,
// through the system voice.

import { DEMO_SCRIPTS, pickScript } from "./demo-scripts.js";
import { syncPhysicsFrame } from "./physics.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  api: null, toast: null, sendMessage: null, switchView: null,
  running: false, cancelled: false,
  audio: null, names: new Map()
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

// ---------------------------------------------------------------- narration

// Piper returns a WAV, played through an AudioContext. The context is created
// lazily and shared, so a demo that speaks thirty lines does not open thirty
// contexts — browsers cap how many a page may hold.
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

function ensureAudio() {
  if (!state.audio || state.audio.state === "closed") state.audio = new AudioContext();
  return state.audio;
}

function playWav(base64) {
  return new Promise((resolve) => {
    const audio = ensureAudio();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    // The callback form still returns a promise, and an undecodable clip would
    // reject it with nobody listening — one bad line of narration would fill
    // the console with unhandled rejections.
    const decoding = audio.decodeAudioData(bytes.buffer, (buffer) => {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.onended = resolve;
      source.start();
    }, () => resolve());
    if (decoding?.catch) decoding.catch(() => resolve());
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

// ------------------------------------------------------------------ running

// "$ball" refers to whatever the step that declared `as: "ball"` created.
function resolve(value) {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  return state.names.get(value.slice(1)) || value;
}

// Put the canvas in the viewport and keep it there.
//
// The panel header and the toolbar are together about 560px tall, so a fresh
// physics view starts with the world below the fold and a running demo looks
// like it is doing nothing. scrollIntoView alone is not enough: called straight
// after the view is shown, the canvas has not been sized yet, so it centres a
// zero-height box and scrolls nowhere. This runs after a frame has been drawn
// and checks the result rather than assuming it.
function focusCanvas() {
  const canvas = document.querySelector("#physics-canvas");
  const scroller = document.scrollingElement;
  if (!canvas || !scroller) return;
  const box = canvas.getBoundingClientRect();
  if (!box.height) return;
  if (box.top >= 0 && box.bottom <= window.innerHeight) return;
  const centred = scroller.scrollTop + box.top - Math.max(0, (window.innerHeight - box.height) / 2);
  scroller.scrollTop = Math.max(0, Math.min(centred, scroller.scrollHeight - window.innerHeight));
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
  // Show what was just built. Without this the demo is invisible: the server
  // has the objects, the canvas has nothing.
  await syncPhysicsFrame().catch(() => {});
  focusCanvas();
}

// A step may declare what it believes it just built. Checked against the same
// perception the AI gets, so a script that silently builds the wrong thing
// stops here rather than being narrated over confidently.
//
// Everything is asserted against `perceive()` because that is the picture the
// canvas draws — the previous round proved that "the action returned an id" and
// "there is something on screen" are different questions.
const WORLD = Object.freeze({ width: 800, height: 600 });

// `lookup` is injectable so this can be exercised headlessly against the real
// engine, where the ids come from that run rather than from a demo's state.
export function checkExpectation(expect, scene, lookup = resolve) {
  const objects = scene?.objects || [];
  const failures = [];

  if (typeof expect.objects === "number" && objects.length !== expect.objects) {
    failures.push(`expected ${expect.objects} objects, found ${objects.length}`);
  }
  if (typeof expect.atLeast === "number" && objects.length < expect.atLeast) {
    failures.push(`expected at least ${expect.atLeast} objects, found ${objects.length}`);
  }

  for (const name of expect.visible || []) {
    const id = lookup(name);
    const object = objects.find((candidate) => candidate.id === id);
    if (!object) {
      failures.push(`${name} is not in the scene`);
      continue;
    }
    // Off the edge of the world is off the edge of the canvas. An object that
    // fell through the floor still exists and still reports a position.
    if (object.x < 0 || object.x > WORLD.width || object.y < 0 || object.y > WORLD.height) {
      failures.push(`${name} is outside the world at ${Math.round(object.x)},${Math.round(object.y)}`);
    }
  }

  // `moved` names objects that should not still be where the step started.
  // This is the one that catches a scene which builds but does nothing — a
  // count cannot see that, and neither can a bounds check.
  for (const name of expect.moved || []) {
    const id = lookup(name);
    const object = objects.find((candidate) => candidate.id === id);
    if (!object) {
      failures.push(`${name} is not in the scene`);
      continue;
    }
    const before = (expect.$before || {})[name];
    if (!before) continue;
    const distance = Math.hypot(object.x - before.x, object.y - before.y);
    if (distance < (expect.movedBy || 20)) {
      failures.push(`${name} barely moved (${Math.round(distance)} px)`);
    }
  }

  return failures;
}

// Positions of the objects a step expects to move, read before it runs. The
// script cannot supply these — where a crate starts is the simulation's answer,
// not the author's.
async function positionsBefore(expect) {
  if (!expect?.moved?.length) return {};
  const scene = await state.api("/api/physics");
  const before = {};
  for (const name of expect.moved) {
    const object = scene.objects.find((candidate) => candidate.id === resolve(name));
    if (object) before[name] = { x: object.x, y: object.y };
  }
  return before;
}

async function verify(expect, before) {
  const scene = await state.api("/api/physics");
  const failures = checkExpectation({ ...expect, $before: before }, scene);
  if (failures.length) throw new Error(`The demo did not build what it described: ${failures.join("; ")}.`);
}

async function runSteps(steps) {
  for (let index = 0; index < steps.length; index += 1) {
    if (state.cancelled) return;
    const step = steps[index];
    status(`Step ${index + 1} of ${steps.length}`, { busy: true });

    if (step.physics) await physics(step.physics);
    if (step.ask && state.sendMessage) {
      // Typed into the real composer so a recording shows it being asked.
      const prompt = $("#prompt");
      if (prompt) prompt.value = "";
      await state.sendMessage(step.prompt || "");
    }

    const before = await positionsBefore(step.expect);

    // The narration and the simulation advance together, so the pacing comes
    // from the sentence rather than from a delay someone guessed.
    const spoken = speak(step.say);
    if (step.run) await runPhysicsFor(step.run);
    await spoken;

    if (step.expect) await verify(step.expect, before);
    if (step.measure) await announce(step.measure);
  }
}

async function runPhysicsFor(totalSteps) {
  let done = 0;
  while (done < totalSteps && !state.cancelled) {
    const batch = Math.min(6, totalSteps - done);
    await state.api("/api/physics/step", { method: "POST", body: JSON.stringify({ steps: batch }) });
    await syncPhysicsFrame().catch(() => {});
    focusCanvas();
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
    // Which one won is read off the scene, not assumed. The result here is not
    // in much doubt, but a demo that announces the answer it was hoping for is
    // no longer showing you the simulation.
    const [firstName, secondName] = measure.names || ["the first", "the second"];
    const ahead = second[axis] > first[axis] ? secondName : firstName;
    await speak(gap < 10
      ? `They finished within ${gap} pixels of each other.`
      : `The ${ahead} crate finished ${gap} pixels further along. Same shape, same slope, same gravity — the only thing that changed was friction.`);
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
    if (script.kind === "physics") {
      state.switchView("physics");
      // The canvas is not laid out yet at this point; focusCanvas runs again
      // after each frame is drawn, which is when its size is real.
      await syncPhysicsFrame().catch(() => {});
      focusCanvas();
    } else {
      state.switchView("chat");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    status("Running…", { busy: true });
    await runSteps(script.steps.map((step) => ({ ...step, prompt: script.prompt })));
    if (!state.cancelled) await speak("That was Evolv, running locally on this computer.");
    status(state.cancelled ? "Demo stopped." : "Demo finished.");
  } catch (error) {
    state.toast(error.message, "error");
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
}
