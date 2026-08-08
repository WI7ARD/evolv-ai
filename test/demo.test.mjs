import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PHYSICS_ACTIONS, PHYSICS_KINDS, MATERIALS } from "../lib/physics.mjs";
import { DemoRecorder, safeName } from "../electron/demo-recorder.mjs";

// The scripts are a browser module; importing them here keeps one copy rather
// than a test-only duplicate that could quietly disagree with what ships.
const { DEMO_SCRIPTS, pickScript } = await import("../public/demo-scripts.js");

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
        // silently mid-recording, which is the worst possible moment.
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
      for (const reference of step.measure?.compare || []) {
        assert.ok(declared.has(String(reference).slice(1)), `${script.id}: ${reference} is measured but never created`);
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

test("the demo narrates through Piper at 1.5x and records without faking anything", async () => {
  const demo = await readFile(new URL("../public/demo.js", import.meta.url), "utf8");

  assert.match(demo, /NARRATION_RATE = 1\.5/);
  assert.match(demo, /synthesize\(line, \{ rate: NARRATION_RATE \}\)/);
  // Piper returns a WAV; it must go through the AudioContext or it cannot be
  // mixed into the recording.
  assert.match(demo, /decodeAudioData/);
  assert.match(demo, /createMediaStreamDestination/);
  assert.match(demo, /video\/webm;codecs=vp9,opus/);

  // A missing Piper must not end the demo.
  assert.match(demo, /speakWithSystemVoice/);
  // Recording is desktop-only and must say so rather than failing silently.
  assert.match(demo, /Recording needs the desktop app/);
});

test("screen capture is only possible while a demo is armed", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");

  // A standing display-media handler would let anything in the window record
  // the screen. It answers only inside the window a demo just opened, and only
  // ever with this window rather than the whole desktop.
  assert.match(main, /setDisplayMediaRequestHandler/);
  assert.match(main, /Date\.now\(\) > demoCaptureArmedUntil.*return callback\(\{\}\)/s);
  assert.match(main, /getMediaSourceId\(\)/);
  assert.match(main, /demoCaptureArmedUntil = Date\.now\(\) \+ /);
  assert.match(main, /"display-capture" && Date\.now\(\) <= demoCaptureArmedUntil/);

  // Packaged, a binary inside app.asar cannot be executed.
  const packer = await readFile(new URL("../scripts/pack-win.mjs", import.meta.url), "utf8");
  assert.match(packer, /node_modules\/ffmpeg-static/);
  assert.match(main, /app\.asar\.unpacked/);
});

test("a recording is written, named safely, and converted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-demo-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  // Names reach the filesystem, so anything a path could misread is stripped.
  assert.equal(safeName('a/b\\c:d*e?"f<g>h|i'), "a b c d e f g h i");
  assert.equal(safeName("   "), "Evolv demo");
  assert.equal(safeName("x".repeat(200)).length, 60);

  const withoutConverter = new DemoRecorder({ ffmpegPath: "", outputDir: root });
  assert.equal(withoutConverter.available(), false);
  const kept = await withoutConverter.save(Buffer.from("not really a video"), { name: "Fallback" });
  // Without a converter the recording is kept, but not renamed to something it
  // is not: an .mp4 that is actually WebM fails in whatever opens it next.
  assert.equal(kept.format, "webm");
  assert.equal(kept.converted, false);
  assert.match(kept.path, /Fallback .*\.webm$/);

  await assert.rejects(() => withoutConverter.save(Buffer.alloc(0)), (error) => error.code === "DEMO_EMPTY");

  // A real conversion, if ffmpeg is installed here.
  let ffmpegPath = "";
  try { ffmpegPath = (await import("ffmpeg-static")).default || ""; } catch { /* optional */ }
  if (!ffmpegPath) return t.skip("ffmpeg-static is not installed in this environment.");

  const source = path.join(root, "sample.webm");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libvpx-vp9", "-b:v", "200k", "-c:a", "libopus", source
  ]);

  const recorder = new DemoRecorder({ ffmpegPath, outputDir: root });
  const saved = await recorder.save(await readFile(source), { name: "Wood vs ice" });
  assert.equal(saved.converted, true);
  assert.equal(saved.format, "mp4");

  // Confirm it really is H.264 in an MP4 container, not a renamed WebM.
  const probe = await promisify(execFile)(ffmpegPath, ["-hide_banner", "-i", saved.path])
    .catch((error) => ({ stderr: error.stderr }));
  assert.match(probe.stderr, /Video: h264/);
  assert.match(probe.stderr, /Audio: aac/);

  // Something that is not a video at all must fail loudly, not produce a
  // zero-byte MP4 that only fails when someone tries to play it.
  const notAVideo = await readFile(new URL("../package.json", import.meta.url));
  await assert.rejects(
    () => new DemoRecorder({ ffmpegPath, outputDir: root }).save(notAVideo, { name: "Junk" }),
    (error) => error.code === "DEMO_CONVERT_FAILED"
  );
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

test("narration survives a refused recording", async () => {
  const demo = await readFile(new URL("../public/demo.js", import.meta.url), "utf8");

  // The AudioContext used to be created only when recording started, so a
  // refused screen-capture left it null and the first Piper line crashed the
  // demo with "Cannot read properties of null". It is now created on demand.
  assert.match(demo, /function ensureAudio\(\)/);
  assert.match(demo, /const audio = ensureAudio\(\);/);
  assert.doesNotMatch(demo, /state\.audio\.decodeAudioData/);
  assert.match(demo, /state\.mixer = ensureAudio\(\)\.createMediaStreamDestination\(\)/);

  // A failed recording is reported and stepped over, never fatal.
  assert.match(demo, /The demo will run without saving a video/);
  assert.match(demo, /return false;/);

  // decodeAudioData's callback form still returns a promise; an undecodable
  // clip rejects it, and with nobody listening one bad line of narration fills
  // the console with unhandled rejections.
  assert.match(demo, /decoding\?\.catch/);
});

test("the window being recorded is resolved without depending on enumeration", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");

  // getSources fetches a thumbnail per window by default, which on a busy
  // desktop is slow enough to miss the permission timeout and surface as a
  // flat "Permission denied".
  assert.match(main, /thumbnailSize: \{ width: 0, height: 0 \}/);
  // And the enumeration does not reliably include the asking window, so its own
  // id is the fallback rather than a refusal.
  assert.match(main, /match \|\| \{ id: own, name: "Evolv" \}/);
});
