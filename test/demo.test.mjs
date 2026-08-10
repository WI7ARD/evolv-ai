import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHYSICS_ACTIONS, PHYSICS_KINDS, MATERIALS, WORLD_WIDTH, WORLD_HEIGHT } from "../lib/physics.mjs";

// The scripts are a browser module; importing them here keeps one copy rather
// than a test-only duplicate that could quietly disagree with what ships.
const { DEMO_SCRIPTS, pickScript } = await import("../public/demo-scripts.js");
const { checkExpectation } = await import("../public/demo.js");

test("every scripted action is one the engine actually handles", () => {
  assert.ok(DEMO_SCRIPTS.length >= 2, "one demo is not a demo button, it is a demo");

  for (const script of DEMO_SCRIPTS) {
    assert.ok(script.id && script.title, "a script needs an id and a title");
    assert.ok(["physics", "chat"].includes(script.kind));
    assert.ok(script.steps.length > 0);

    for (const step of script.steps) {
      assert.equal(typeof step.say, "string", `${script.id}: every step must declare narration, even if empty`);
      for (const action of step.physics || []) {
        // The guard that matters: a script naming create_pyramid would fail
        // silently mid-demo, which is the worst possible moment.
        assert.ok(PHYSICS_ACTIONS.includes(action.action), `${script.id}: unknown action ${action.action}`);
        if (action.action.startsWith("create_")) {
          assert.ok(PHYSICS_KINDS.includes(action.action.slice("create_".length)), `${script.id}: unknown kind in ${action.action}`);
        }
        if (action.material) assert.ok(MATERIALS[action.material], `${script.id}: unknown material ${action.material}`);
      }
    }
  }
});

test("a script never names an object it did not create", () => {
  for (const script of DEMO_SCRIPTS) {
    const declared = new Set();
    for (const step of script.steps) {
      for (const action of step.physics || []) {
        // References resolve against names declared earlier, so a step cannot
        // push something that does not exist yet.
        for (const value of Object.values(action)) {
          if (typeof value === "string" && value.startsWith("$")) {
            assert.ok(declared.has(value.slice(1)), `${script.id}: ${value} is used before it is declared`);
          }
        }
        if (action.as) declared.add(action.as);
      }
      // Expectations name objects too, and a typo there fails the demo at the
      // exact moment it is meant to be reassuring.
      for (const reference of [...(step.expect?.visible || []), ...(step.expect?.moved || []), ...(step.measure?.compare || [])]) {
        assert.ok(declared.has(String(reference).slice(1)), `${script.id}: ${reference} is referenced but never created`);
      }
    }
    // Nothing should hard-code an id: they shift the moment a step is inserted.
    const text = JSON.stringify(script);
    assert.doesNotMatch(text, /"(box|circle|ramp|chain|car|ragdoll|gear|motor)-\d+"/, `${script.id} hard-codes an object id`);
  }
});

test("a chat demo asks a real question and a physics demo does not", () => {
  for (const script of DEMO_SCRIPTS) {
    const asks = script.steps.some((step) => step.ask);
    if (script.kind === "chat") {
      assert.ok(asks, `${script.id}: a chat demo must actually ask something`);
      assert.ok((script.prompt || "").length > 40, `${script.id}: the prompt should be a real question`);
    } else {
      assert.equal(asks, false, `${script.id}: a physics demo should not send chat messages`);
    }
  }
  assert.equal(pickScript("friction").id, "friction");
  assert.ok(DEMO_SCRIPTS.includes(pickScript("nonexistent")), "an unknown id still returns something runnable");
});

test("the demo narrates through Piper at 1.5x without faking anything", async () => {
  const demo = await readFile(new URL("../public/demo.js", import.meta.url), "utf8");

  assert.match(demo, /NARRATION_RATE = 1\.5/);
  assert.match(demo, /synthesize\(line, \{ rate: NARRATION_RATE \}\)/);
  // Piper returns a WAV, played through an AudioContext.
  assert.match(demo, /decodeAudioData/);
  // A missing Piper must not end the demo.
  assert.match(demo, /speakWithSystemVoice/);

  // The AudioContext used to be created only when recording started, so a
  // refused screen capture left it null and the first Piper line crashed the
  // demo with "Cannot read properties of null". It is created on demand.
  assert.match(demo, /function ensureAudio\(\)/);
  assert.match(demo, /const audio = ensureAudio\(\);/);
  assert.doesNotMatch(demo, /state\.audio\.decodeAudioData/);

  // decodeAudioData's callback form still returns a promise; an undecodable
  // clip rejects it, and with nobody listening one bad line of narration fills
  // the console with unhandled rejections.
  assert.match(demo, /decoding\?\.catch/);
});

test("no half-removed recorder is left behind", async () => {
  // Screen capture was refused on the machines that mattered and has been
  // taken out entirely. A partial removal is worse than either state: a dead
  // permission clause still widens what the window may do, and a stale bridge
  // still ships the IPC surface.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const traces = /MediaRecorder|getDisplayMedia|setDisplayMediaRequestHandler|desktopCapturer|display-capture|ffmpeg|demoCaptureArmed|evolvDemo|demo-recorder|createMediaStreamDestination/i;

  for (const directory of ["public", "electron", "scripts"]) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(m?js|cjs|html|css)$/.test(entry.name)) continue;
      const source = await readFile(path.join(root, directory, entry.name), "utf8");
      const hit = source.match(traces);
      assert.equal(hit, null, `${directory}/${entry.name} still references ${hit?.[0]}`);
    }
  }

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal("ffmpeg-static" in (manifest.dependencies || {}), false, "ffmpeg is still a dependency");

  // And the panel says what it now expects of the viewer, rather than
  // promising a file it will never write.
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  assert.doesNotMatch(html, /id="demo-reveal"/);
  assert.match(html, /screen recorder you already use/);

  // Prose, not just API names. The sweep above greps for MediaRecorder and
  // friends, which is why the /demo command description sat there for three
  // commits still telling people Evolv would "record an experiment" — a promise
  // in plain English that no identifier match could ever catch.
  // Sentences only. `voice.recording` and the "recording" CSS class are the
  // microphone, which is a real feature and must not trip this — so the sweep
  // looks at quoted prose and at rendered HTML text, not at identifiers.
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");
  const prose = [
    ...(app.match(/"[^"\n]{16,}"|'[^'\n]{16,}'/g) || []),
    ...html.replace(/<[^>]*>/g, " ").split(/(?<=[.!?])\s+/)
  ];
  // "Knowledge record deleted" is a database record, not a claim about video,
  // so a sentence only counts when it pairs a record-verb with the thing that
  // would be recorded.
  const allowed = /screen recorder you already use|does not record itself/;
  for (const sentence of prose) {
    if (!/\brecord(s|ed|ing|er)?\b/i.test(sentence)) continue;
    if (!/\b(demo|screen|video|mp4|clip|capture|experiment)\b/i.test(sentence)) continue;
    assert.match(sentence, allowed,
      `user-facing text still claims Evolv records: ${sentence.trim().slice(0, 120)}`);
  }
});

test("the demo stays stoppable after it navigates away from its own panel", async () => {
  const [html, demo] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/demo.js", import.meta.url), "utf8")
  ]);

  // The demo switches to whichever view it is showing off, which puts its own
  // Stop button inside a hidden section — exactly when someone wants it. The
  // indicator therefore lives outside the views, at body level.
  const views = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.doesNotMatch(views, /id="demo-hud"/, "the indicator must not live inside a view");
  assert.match(html, /id="demo-hud"/);
  assert.match(html, /id="demo-hud-stop"/);
  assert.match(demo, /#demo-hud-stop/);
  assert.match(demo, /\$\("#demo-hud"\)\?\.classList\.toggle\("hidden", !busy\)/);

  // And it is reachable by command like every other view.
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /name: "\/demo"/);
  assert.match(html, /id="demo-view"/);
  assert.match(html.match(/id="composer-hint"[^>]*>([^<]*)</)?.[1] || "", /\/demo\b/);
});

// Runs a physics script headlessly through the real engine, exactly as the
// browser runner does, and returns what each step ended up looking like.
async function runScript(script) {
  const { PhysicsService } = await import("../lib/physics.mjs");
  const physics = new PhysicsService();
  const names = new Map();
  const lookup = (value) => (typeof value === "string" && value.startsWith("$") ? names.get(value.slice(1)) || value : value);
  const timeline = [];

  for (const step of script.steps) {
    const before = {};
    for (const name of step.expect?.moved || []) {
      const object = physics.perceive().objects.find((candidate) => candidate.id === lookup(name));
      if (object) before[name] = { x: object.x, y: object.y };
    }

    for (const action of step.physics || []) {
      const { action: verb, as, ...parameters } = action;
      if (parameters.id) parameters.id = lookup(parameters.id);
      const created = physics.apply(verb, parameters);
      if (as && created?.id) names.set(as, created.id);
    }
    if (step.run) physics.step(step.run);

    timeline.push({ step, before, scene: physics.perceive() });
  }
  return { timeline, names, lookup, scene: physics.perceive() };
}

test("a physics script actually produces the thing it narrates", async () => {
  // Every script is run headlessly through the real engine. A script can be
  // perfectly well-formed and still show nothing — an earlier impact demo
  // narrated a wrecking ball on a chain and built a ball that was never
  // attached to it, which only became obvious on screen.
  for (const script of DEMO_SCRIPTS.filter((item) => item.kind === "physics")) {
    const { timeline, names, scene } = await runScript(script);

    assert.ok(scene.objectCount >= 2, `${script.id}: built almost nothing`);
    assert.ok(
      timeline.some(({ step }) => step.expect?.moved?.length),
      `${script.id}: nothing is asserted to move, so an inert demo would pass`
    );

    // And every name a later step referenced must have resolved.
    for (const step of script.steps) {
      for (const action of step.physics || []) {
        if (typeof action.id === "string" && action.id.startsWith("$")) {
          assert.ok(names.has(action.id.slice(1)), `${script.id}: ${action.id} never resolved to a real object`);
        }
      }
    }
  }
});

test("every expectation a script declares holds when it is really run", async () => {
  for (const script of DEMO_SCRIPTS.filter((item) => item.kind === "physics")) {
    const { timeline, lookup } = await runScript(script);

    for (const [index, { step, before, scene }] of timeline.entries()) {
      if (!step.expect) continue;
      const failures = checkExpectation({ ...step.expect, $before: before }, scene, lookup);
      assert.deepEqual(failures, [], `${script.id} step ${index + 1}: ${failures.join("; ")}`);
    }
  }
});

test("a demo builds inside the frame the canvas actually draws", async () => {
  // The world is 800x600 and the canvas is fitted to it. Anything built or
  // flung outside those bounds is invisible however correct the simulation is,
  // and the previous round of this demo lost a crate off the bottom that way.
  for (const script of DEMO_SCRIPTS.filter((item) => item.kind === "physics")) {
    const { timeline } = await runScript(script);

    for (const [index, { scene }] of timeline.entries()) {
      for (const object of scene.objects) {
        assert.equal(object.offScreen, false, `${script.id} step ${index + 1}: ${object.id} fell out of the world`);
        assert.ok(
          object.x >= 0 && object.x <= WORLD_WIDTH && object.y >= 0 && object.y <= WORLD_HEIGHT,
          `${script.id} step ${index + 1}: ${object.id} sits at ${Math.round(object.x)},${Math.round(object.y)}, outside the ${WORLD_WIDTH}x${WORLD_HEIGHT} view`
        );
      }
    }
  }
});

test("an expectation fails loudly rather than being narrated over", () => {
  // The point of `expect` is that a wrong scene stops the demo. If these
  // stopped detecting anything, a script could build nothing at all and the
  // narration would happily describe it.
  const scene = { objects: [{ id: "box-1", x: 100, y: 100 }, { id: "box-2", x: 900, y: 50 }] };
  const lookup = (name) => ({ $a: "box-1", $b: "box-2", $gone: "box-9" })[name] || name;

  assert.deepEqual(checkExpectation({ objects: 2 }, scene, lookup), []);
  assert.deepEqual(checkExpectation({ atLeast: 2 }, scene, lookup), []);
  assert.match(checkExpectation({ objects: 5 }, scene, lookup)[0], /expected 5 objects, found 2/);
  assert.match(checkExpectation({ atLeast: 3 }, scene, lookup)[0], /at least 3/);
  assert.match(checkExpectation({ visible: ["$gone"] }, scene, lookup)[0], /not in the scene/);
  assert.match(checkExpectation({ visible: ["$b"] }, scene, lookup)[0], /outside the world/);
  assert.deepEqual(checkExpectation({ visible: ["$a"] }, scene, lookup), []);

  const stayed = { moved: ["$a"], $before: { $a: { x: 100, y: 95 } } };
  assert.match(checkExpectation(stayed, scene, lookup)[0], /barely moved \(5 px\)/);
  assert.deepEqual(checkExpectation({ ...stayed, movedBy: 4 }, scene, lookup), []);
  // No recorded start means nothing to compare against, not a failure.
  assert.deepEqual(checkExpectation({ moved: ["$a"] }, scene, lookup), []);
});
