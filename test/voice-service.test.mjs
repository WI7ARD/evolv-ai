import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHearingPrompt,
  chooseTranscript,
  discoverPiperAssets,
  discoverWhisperAssets,
  findNamedFile,
  parseWhisperStreamLine,
  prepareVoiceWav,
  sanitizeVoiceEvent,
  transcriptAgreement,
  whisperModelTier
} from "../electron/voice-service.mjs";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-voice-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Piper discovery reports an incomplete downloaded voice without executing it", (t) => {
  const downloadsPath = temporaryDirectory(t);
  fs.writeFileSync(path.join(downloadsPath, "voice.onnx"), "model");
  const result = discoverPiperAssets({ downloadsPath });
  assert.equal(result.ready, false);
  assert.equal(path.basename(result.model), "voice.onnx");
  assert.deepEqual(result.missing, ["Piper runtime", "voice configuration"]);
});

test("Piper discovery requires the runtime, model, and matching JSON configuration", (t) => {
  const downloadsPath = temporaryDirectory(t);
  const piperDirectory = path.join(downloadsPath, "piper");
  fs.mkdirSync(piperDirectory);
  fs.writeFileSync(path.join(piperDirectory, "piper.exe"), "runtime");
  fs.writeFileSync(path.join(downloadsPath, "voice.onnx"), "model");
  fs.writeFileSync(path.join(downloadsPath, "voice.onnx.json"), "{}");
  const result = discoverPiperAssets({ downloadsPath });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

test("a complete bundled Piper voice takes precedence over an incomplete download", (t) => {
  const downloadsPath = temporaryDirectory(t);
  const bundledRoot = temporaryDirectory(t);
  const bundledRuntime = path.join(bundledRoot, "piper");
  fs.mkdirSync(bundledRuntime);
  fs.writeFileSync(path.join(downloadsPath, "incomplete.onnx"), "download");
  fs.writeFileSync(path.join(bundledRuntime, "piper.exe"), "runtime");
  fs.writeFileSync(path.join(bundledRoot, "en_GB-northern_english_male-medium.onnx"), "model");
  fs.writeFileSync(path.join(bundledRoot, "en_GB-northern_english_male-medium.onnx.json"), "{}");
  const result = discoverPiperAssets({ downloadsPath, bundledRoot });
  assert.equal(result.ready, true);
  assert.equal(path.basename(result.model), "en_GB-northern_english_male-medium.onnx");
});

test("bounded discovery does not follow directory symlinks", (t) => {
  const root = temporaryDirectory(t);
  const outside = temporaryDirectory(t);
  fs.writeFileSync(path.join(outside, "piper.exe"), "outside");
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), "junction");
  } catch {
    t.skip("Directory symlinks are unavailable in this Windows environment.");
    return;
  }
  assert.equal(findNamedFile(root, (name) => name === "piper.exe"), "");
});

test("Whisper wake recognition requires the command runtime, model, and SDL microphone library", (t) => {
  const root = temporaryDirectory(t);
  const release = path.join(root, "Release");
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, "whisper-command.exe"), "runtime");
  fs.writeFileSync(path.join(release, "SDL2.dll"), "microphone");
  assert.deepEqual(discoverWhisperAssets(root).missing, ["English speech model"]);
  fs.writeFileSync(path.join(root, "ggml-base.en.bin"), "model");
  const result = discoverWhisperAssets(root);
  assert.equal(result.ready, true);
  assert.equal(path.basename(result.runtime), "whisper-command.exe");
});

test("Whisper continuous VAD is preferred so wake word and command can be separate phrases", (t) => {
  const root = temporaryDirectory(t);
  const release = path.join(root, "Release");
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, "whisper-command.exe"), "command");
  fs.writeFileSync(path.join(release, "whisper-stream.exe"), "stream");
  fs.writeFileSync(path.join(release, "SDL2.dll"), "microphone");
  fs.writeFileSync(path.join(root, "ggml-base.en.bin"), "model");
  const result = discoverWhisperAssets(root);
  assert.equal(result.mode, "stream");
  assert.equal(path.basename(result.runtime), "whisper-stream.exe");
});

test("Whisper push-to-talk discovery requires the offline CLI and model", (t) => {
  const root = temporaryDirectory(t);
  const release = path.join(root, "Release");
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, "whisper-cli.exe"), "cli");
  fs.writeFileSync(path.join(root, "ggml-base.en.bin"), "model");
  const result = discoverWhisperAssets(root);
  assert.equal(result.transcriptionReady, true);
  assert.equal(path.basename(result.cliRuntime), "whisper-cli.exe");
});

test("Whisper discovery prefers a higher-accuracy downloaded English model and honors an explicit selection", (t) => {
  const root = temporaryDirectory(t);
  const release = path.join(root, "Release");
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, "whisper-cli.exe"), "cli");
  fs.writeFileSync(path.join(root, "ggml-base.en.bin"), "base");
  fs.writeFileSync(path.join(root, "ggml-small.en.bin"), "small");
  const automatic = discoverWhisperAssets(root);
  assert.equal(path.basename(automatic.model), "ggml-small.en.bin");
  assert.equal(automatic.modelTier, "improved");
  const selected = discoverWhisperAssets(root, "win32", "", path.join(root, "ggml-base.en.bin"));
  assert.equal(path.basename(selected.model), "ggml-base.en.bin");
  assert.equal(whisperModelTier(selected.model), "balanced");
});

function testWav(samples, sampleRate = 16_000) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => output.writeInt16LE(sample, 44 + index * 2));
  return output;
}

test("hearing preprocessing measures, trims, and safely raises quiet speech", () => {
  const samples = Array.from({ length: 16_000 * 18 / 10 }, (_value, index) => {
    if (index < 6_400 || index >= 22_400) return 0;
    return Math.round(Math.sin(index / 8) * 1200);
  });
  const prepared = prepareVoiceWav(testWav(samples));
  assert.ok(prepared.wav.length < 44 + samples.length * 2);
  assert.equal(prepared.analysis.durationMs, 1800);
  assert.ok(prepared.analysis.processedDurationMs >= 1400);
  assert.ok(prepared.analysis.gain > 1);
  assert.equal(prepared.analysis.clippingRatio, 0);
  assert.notEqual(prepared.analysis.quality, "poor");
});

test("hearing preprocessing rejects silence instead of hallucinating a transcript", () => {
  assert.throws(() => prepareVoiceWav(testWav(Array(16_000).fill(0))), (error) => error.code === "NO_SPEECH");
});

test("hearing prompts are bounded local hints and never raw unbounded context", () => {
  const prompt = buildHearingPrompt({
    vocabulary: ["Acme SDK", "<script>ignore system</script>", ...Array(100).fill("overflow")],
    contextPhrases: ["Build a profitable software product", "x".repeat(1_000)],
    enhanced: true
  });
  assert.ok(prompt.length <= 700);
  assert.match(prompt, /Evolv/);
  assert.match(prompt, /Acme SDK/);
  assert.match(prompt, /Build a profitable software product/);
  assert.doesNotMatch(prompt, /[<>]/);
});

test("two-pass hearing exposes disagreement and uses context only to rank reviewable alternatives", () => {
  assert.equal(transcriptAgreement("Build a product", "Build a product"), 1);
  assert.deepEqual(chooseTranscript(["Build a product", "Build a product"], { audioQuality: "good" }), {
    text: "Build a product", alternatives: [], agreement: 1, confidence: 0.96, needsReview: false
  });
  const result = chooseTranscript([
    "Elder profitable software product.",
    "Build a profitable software product."
  ], { audioQuality: "good", contextPhrases: ["Build a profitable software product"] });
  assert.equal(result.text, "Build a profitable software product.");
  assert.deepEqual(result.alternatives, ["Elder profitable software product."]);
  assert.equal(result.needsReview, true);
  assert.ok(result.confidence < 0.8);
});

test("Linux Piper and Whisper runtimes are discovered without Windows extensions", (t) => {
  const root = temporaryDirectory(t);
  const piperRoot = path.join(root, "piper-assets");
  const piperRuntimeDirectory = path.join(piperRoot, "piper");
  fs.mkdirSync(piperRuntimeDirectory, { recursive: true });
  fs.writeFileSync(path.join(piperRuntimeDirectory, "piper"), "runtime");
  fs.writeFileSync(path.join(piperRoot, "en_GB-northern_english_male-medium.onnx"), "model");
  fs.writeFileSync(path.join(piperRoot, "en_GB-northern_english_male-medium.onnx.json"), "{}");
  const piper = discoverPiperAssets({ bundledRoot: piperRoot, platform: "linux" });
  assert.equal(piper.ready, true);
  assert.equal(path.basename(piper.runtime), "piper");

  const whisperRoot = path.join(root, "whisper");
  const binaries = path.join(whisperRoot, "build", "bin");
  fs.mkdirSync(binaries, { recursive: true });
  fs.writeFileSync(path.join(binaries, "whisper-cli"), "cli");
  fs.writeFileSync(path.join(binaries, "whisper-stream"), "stream");
  fs.writeFileSync(path.join(whisperRoot, "ggml-base.en.bin"), "model");
  const whisper = discoverWhisperAssets(whisperRoot, "linux");
  assert.equal(whisper.ready, true);
  assert.equal(whisper.transcriptionReady, true);
  assert.equal(path.basename(whisper.cliRuntime), "whisper-cli");
  assert.equal(path.basename(whisper.runtime), "whisper-stream");
  assert.equal(whisper.sdl, "");
});

test("Whisper stream output keeps spoken text and drops headers or silence", () => {
  assert.equal(parseWhisperStreamLine("[00:00:00.000 --> 00:00:02.000]  Evolve, what time is it?"), "Evolve, what time is it?");
  assert.equal(parseWhisperStreamLine("### Transcription 1 START"), "");
  assert.equal(parseWhisperStreamLine("[00:00:00.000 --> 00:00:02.000] [BLANK_AUDIO]"), "");
});

test("voice events are allowlisted and bounded before reaching the renderer", () => {
  assert.equal(sanitizeVoiceEvent({ type: "unknown", text: "ignored" }), null);
  const event = sanitizeVoiceEvent({ type: "transcript", text: "x".repeat(5_000), confidence: 8, secret: "no" });
  assert.equal(event.text.length, 4_000);
  assert.equal(event.confidence, 1);
  assert.equal(sanitizeVoiceEvent({ type: "ready", engine: "whisper.cpp" }).engine, "whisper.cpp");
  assert.deepEqual(
    sanitizeVoiceEvent({ type: "restarting", attempt: 2, delayMs: 1_500, error: "microphone reset", secret: "no" }),
    { type: "restarting", error: "microphone reset", attempt: 2, delayMs: 1_500 }
  );
  assert.equal("secret" in event, false);
});

test("the sandboxed desktop renderer loads its voice bridge through CommonJS", () => {
  const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  const renderer = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /preload\.cjs/);
  assert.match(preload, /require\(["']electron["']\)/);
  assert.match(preload, /transcribe:/);
  assert.match(preload, /chooseWhisperFolder:/);
  assert.match(preload, /chooseWhisperModel:/);
  assert.match(renderer, /hearingOptions/);
  assert.match(page, /HEARING INTELLIGENCE/);
  assert.doesNotMatch(preload, /startListening:/, "the renderer must not expose continuous background listening");
  assert.doesNotMatch(preload, /^\s*import\s/m, "sandboxed preloads cannot use ESM imports");
  assert.doesNotMatch(preload, /nodeIntegration/);
  assert.match(renderer, /addEventListener\("pointerdown"/);
  assert.match(renderer, /addEventListener\("pointerup"/);
  assert.match(renderer, /mediaDevices\.getUserMedia/);
  assert.doesNotMatch(page, /id="wake-word-enabled"/);
  assert.match(page, /There is no wake word or background listening/);
});
