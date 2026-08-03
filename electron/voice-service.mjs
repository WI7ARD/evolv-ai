import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const MAX_TRANSCRIPT_EVENT = 4_000;
const MAX_TTS_TEXT = 20_000;
const MAX_PUSH_TO_TALK_WAV = 4 * 1024 * 1024;
const MAX_HEARING_PROMPT = 700;
const DEFAULT_HEARING_TERMS = Object.freeze([
  "Evolv", "Ollama", "Obsidian", "Whisper.cpp", "Piper", "Gemini", "OpenAI",
  "API", "SQLite", "JavaScript", "TypeScript", "Python", "Electron", "itch.io"
]);
const VAD_THRESHOLDS = Object.freeze({ high: 0.18, balanced: 0.30, low: 0.45 });
const MAX_LISTENER_RESTARTS = 3;

function existingFile(value, expectedExtension = "") {
  if (!value || typeof value !== "string") return "";
  const resolved = path.resolve(value);
  if (expectedExtension && path.extname(resolved).toLowerCase() !== expectedExtension) return "";
  try {
    return fs.statSync(resolved).isFile() ? resolved : "";
  } catch {
    return "";
  }
}

function platformRuntimeNames(platform = process.platform) {
  return platform === "win32"
    ? {
        piper: "piper.exe",
        whisperStream: "whisper-stream.exe",
        whisperCommand: "whisper-command.exe",
        whisperCli: "whisper-cli.exe"
      }
    : {
        piper: "piper",
        whisperStream: "whisper-stream",
        whisperCommand: "whisper-command",
        whisperCli: "whisper-cli"
      };
}

function firstExistingFile(candidates, expectedExtension = "") {
  for (const candidate of candidates) {
    const result = existingFile(candidate, expectedExtension);
    if (result) return result;
  }
  return "";
}

export function findNamedFile(root, predicate, { maxEntries = 5_000, maxDepth = 5 } = {}) {
  if (!root || !fs.existsSync(root)) return "";
  const queue = [{ directory: path.resolve(root), depth: 0 }];
  let seen = 0;
  while (queue.length && seen < maxEntries) {
    const { directory, depth } = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > maxEntries) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && predicate(entry.name, candidate)) return candidate;
      if (entry.isDirectory() && depth < maxDepth && !entry.isSymbolicLink()) {
        queue.push({ directory: candidate, depth: depth + 1 });
      }
    }
  }
  return "";
}

export function findNamedFiles(root, predicate, { maxEntries = 5_000, maxDepth = 5, maxResults = 30 } = {}) {
  if (!root || !fs.existsSync(root)) return [];
  const queue = [{ directory: path.resolve(root), depth: 0 }];
  const results = [];
  let seen = 0;
  while (queue.length && seen < maxEntries && results.length < maxResults) {
    const { directory, depth } = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > maxEntries || results.length >= maxResults) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && predicate(entry.name, candidate)) results.push(candidate);
      if (entry.isDirectory() && depth < maxDepth && !entry.isSymbolicLink()) queue.push({ directory: candidate, depth: depth + 1 });
    }
  }
  return results;
}

function whisperModelRank(modelPath) {
  const name = path.basename(modelPath || "").toLowerCase();
  if (/large-v?3/.test(name)) return 90;
  if (/large/.test(name)) return 80;
  if (/medium\.en/.test(name)) return 70;
  if (/medium/.test(name)) return 65;
  if (/small\.en/.test(name)) return 60;
  if (/small/.test(name)) return 55;
  if (/base\.en/.test(name)) return 40;
  if (/base/.test(name)) return 35;
  if (/tiny\.en/.test(name)) return 20;
  if (/tiny/.test(name)) return 15;
  return 1;
}

export function whisperModelTier(modelPath) {
  const rank = whisperModelRank(modelPath);
  return rank >= 80 ? "maximum" : rank >= 65 ? "high" : rank >= 55 ? "improved" : rank >= 35 ? "balanced" : "fast";
}

export function discoverPiperAssets({ downloadsPath = "", bundledRoot = "", configured = {}, platform = process.platform } = {}) {
  const names = platformRuntimeNames(platform);
  const configuredRuntime = existingFile(configured.runtime);
  const configuredModel = existingFile(configured.model, ".onnx");
  const configuredConfig = configuredModel ? existingFile(`${configuredModel}.json`, ".json") : "";
  if (configuredRuntime && configuredModel && configuredConfig) {
    return { runtime: configuredRuntime, model: configuredModel, config: configuredConfig, ready: true, missing: [] };
  }
  const bundledRuntime = bundledRoot ? firstExistingFile([
    path.join(bundledRoot, "piper", names.piper),
    path.join(bundledRoot, names.piper)
  ]) : "";
  const bundledModel = bundledRoot ? existingFile(path.join(bundledRoot, "en_GB-northern_english_male-medium.onnx"), ".onnx") : "";
  const bundledConfig = bundledModel ? existingFile(`${bundledModel}.json`, ".json") : "";
  if (bundledRuntime && bundledModel && bundledConfig) {
    return { runtime: bundledRuntime, model: bundledModel, config: bundledConfig, ready: true, missing: [] };
  }
  const runtime = configuredRuntime || bundledRuntime
    || findNamedFile(downloadsPath, (name) => name.toLowerCase() === names.piper);
  const model = configuredModel || bundledModel
    || findNamedFile(downloadsPath, (name) => name.toLowerCase().endsWith(".onnx"));
  const config = model ? existingFile(`${model}.json`, ".json") : "";
  return {
    runtime,
    model,
    config,
    ready: Boolean(runtime && model && config),
    missing: [!runtime && "Piper runtime", !model && "voice model", model && !config && "voice configuration"].filter(Boolean)
  };
}

export function discoverWhisperAssets(whisperRoot = "", platform = process.platform, fallbackModelRoot = "", configuredModelPath = "") {
  const root = whisperRoot ? path.resolve(whisperRoot) : "";
  const names = platformRuntimeNames(platform);
  const runtimeDirectories = root
    ? [path.join(root, "Release"), path.join(root, "build", "bin"), path.join(root, "bin"), root]
    : [];
  const streamRuntime = firstExistingFile(runtimeDirectories.map((directory) => path.join(directory, names.whisperStream)));
  const commandRuntime = firstExistingFile(runtimeDirectories.map((directory) => path.join(directory, names.whisperCommand)));
  const runtime = streamRuntime || commandRuntime;
  const cliRuntime = firstExistingFile(runtimeDirectories.map((directory) => path.join(directory, names.whisperCli)));
  const configuredModel = existingFile(configuredModelPath, ".bin");
  const validModel = (name) => /^ggml-(?!silero|vad)[a-z0-9._-]+\.bin$/i.test(name);
  const rootModels = root ? findNamedFiles(root, validModel, { maxDepth: 3 }) : [];
  const fallbackModels = fallbackModelRoot ? findNamedFiles(path.resolve(fallbackModelRoot), validModel, { maxDepth: 2 }) : [];
  const model = configuredModel
    || rootModels.sort((left, right) => whisperModelRank(right) - whisperModelRank(left))[0]
    || fallbackModels.sort((left, right) => whisperModelRank(right) - whisperModelRank(left))[0]
    || "";
  const sdl = platform === "win32" && root ? existingFile(path.join(root, "Release", "SDL2.dll"), ".dll") : "";
  return {
    runtime,
    cliRuntime,
    mode: streamRuntime ? "stream" : "command",
    model,
    sdl,
    ready: Boolean(runtime && model && (platform !== "win32" || sdl)),
    transcriptionReady: Boolean(cliRuntime && model),
    modelTier: model ? whisperModelTier(model) : "",
    missing: [
      !runtime && "Whisper microphone runtime",
      !model && "English speech model",
      platform === "win32" && !sdl && "microphone runtime"
    ].filter(Boolean)
  };
}

function findWaveChunk(wav, name) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkName = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (chunkName === name) return { headerOffset: offset, dataOffset: offset + 8, size: Math.min(size, wav.length - offset - 8) };
    offset += 8 + size + (size % 2);
  }
  return null;
}

function wavError(message, code = "INVALID_AUDIO") {
  return Object.assign(new Error(message), { code });
}

export function prepareVoiceWav(input) {
  const wav = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (wav.length < 44 || wav.subarray(0, 4).toString("ascii") !== "RIFF" || wav.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw wavError("Push-to-talk audio must be a WAV recording.");
  }
  const format = findWaveChunk(wav, "fmt ");
  const data = findWaveChunk(wav, "data");
  if (!format || format.size < 16 || !data || data.size < 2) throw wavError("The WAV recording is incomplete.");
  const audioFormat = wav.readUInt16LE(format.dataOffset);
  const channels = wav.readUInt16LE(format.dataOffset + 2);
  const sampleRate = wav.readUInt32LE(format.dataOffset + 4);
  const bits = wav.readUInt16LE(format.dataOffset + 14);
  if (audioFormat !== 1 || channels !== 1 || bits !== 16 || sampleRate < 8_000 || sampleRate > 96_000) {
    throw wavError("Push-to-talk requires mono 16-bit PCM WAV audio.");
  }
  const sampleCount = Math.floor(data.size / 2);
  const samples = new Int16Array(sampleCount);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = wav.readInt16LE(data.dataOffset + index * 2);
    samples[index] = sample;
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, Math.abs(normalized));
    if (Math.abs(normalized) >= 0.985) clipped += 1;
  }
  const durationMs = sampleCount / sampleRate * 1000;
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const frames = [];
  for (let start = 0; start < sampleCount; start += frameSize) {
    const end = Math.min(sampleCount, start + frameSize);
    let squares = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index] / 32768;
      squares += value * value;
    }
    frames.push({ start, end, rms: Math.sqrt(squares / Math.max(1, end - start)) });
  }
  const levels = frames.map((frame) => frame.rms).sort((left, right) => left - right);
  const noiseFloor = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.2))] || 0;
  const threshold = Math.max(0.006, noiseFloor * 2.8);
  const active = frames.filter((frame) => frame.rms >= threshold);
  const speechMs = active.length * 20;
  const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
  if (durationMs < 180) throw wavError("Hold the microphone button a little longer while speaking.", "AUDIO_TOO_SHORT");
  if (!active.length || speechMs < 140 || rms < 0.0015) throw wavError("No clear speech was detected in the recording.", "NO_SPEECH");
  const pad = Math.round(sampleRate * 0.24);
  const startSample = Math.max(0, active[0].start - pad);
  const endSample = Math.min(sampleCount, active.at(-1).end + pad);
  let speechSquares = 0;
  let speechSamples = 0;
  for (const frame of active) {
    for (let index = frame.start; index < frame.end; index += 1) {
      const value = samples[index] / 32768;
      speechSquares += value * value;
      speechSamples += 1;
    }
  }
  const speechRms = Math.sqrt(speechSquares / Math.max(1, speechSamples));
  const desiredGain = 0.12 / Math.max(0.0001, speechRms);
  const gain = Math.max(0.7, Math.min(3, desiredGain, peak ? 0.96 / peak : 1));
  const trimmed = samples.subarray(startSample, endSample);
  const output = Buffer.alloc(44 + trimmed.length * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(trimmed.length * 2, 40);
  for (let index = 0; index < trimmed.length; index += 1) {
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(trimmed[index] * gain))), 44 + index * 2);
  }
  const snrDb = 20 * Math.log10(Math.max(speechRms, 0.00001) / Math.max(noiseFloor, 0.00001));
  const clippingRatio = clipped / Math.max(1, sampleCount);
  const speechRatio = speechMs / Math.max(1, durationMs);
  const issues = [
    rms < 0.012 && "quiet",
    clippingRatio > 0.01 && "clipping",
    speechRatio < 0.2 && "mostly-silence",
    snrDb < 8 && "noisy"
  ].filter(Boolean);
  const quality = issues.length >= 2 || snrDb < 4 ? "poor" : issues.length ? "fair" : "good";
  return {
    wav: output,
    analysis: {
      durationMs: Math.round(durationMs), processedDurationMs: Math.round(trimmed.length / sampleRate * 1000),
      rms: Number(rms.toFixed(4)), peak: Number(peak.toFixed(4)), clippingRatio: Number(clippingRatio.toFixed(4)),
      noiseFloor: Number(noiseFloor.toFixed(4)), snrDb: Number(Math.max(0, Math.min(60, snrDb)).toFixed(1)),
      speechRatio: Number(Math.min(1, speechRatio).toFixed(3)), gain: Number(gain.toFixed(2)), quality, issues
    }
  };
}

function sanitizeHearingTerms(values, max = 40) {
  const result = [];
  for (const value of values || []) {
    const clean = String(value || "").replace(/[^a-z0-9+#._ '-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean && !result.some((item) => item.toLowerCase() === clean.toLowerCase())) result.push(clean);
    if (result.length >= max) break;
  }
  return result;
}

export function buildHearingPrompt({ vocabulary = [], contextPhrases = [], enhanced = false } = {}) {
  const terms = sanitizeHearingTerms([...DEFAULT_HEARING_TERMS, ...vocabulary]);
  const phrases = sanitizeHearingTerms(contextPhrases, 4).map((item) => item.slice(0, 140));
  return [
    "Accurate local dictation for the Evolv personal engineering assistant.",
    `Likely names and technical terms: ${terms.join(", ")}.`,
    phrases.length ? `Recent local conversation may include: ${phrases.join("; ")}.` : "",
    enhanced ? "Preserve the user's exact request, numbers, filenames, and API or product names." : ""
  ].filter(Boolean).join(" ").slice(0, MAX_HEARING_PROMPT);
}

function transcriptWords(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9+#._-]+/g) || [];
}

export function transcriptAgreement(left, right) {
  const a = transcriptWords(left);
  const b = transcriptWords(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return Number((1 - matrix[a.length][b.length] / Math.max(a.length, b.length)).toFixed(3));
}

function candidateScore(text, phrases) {
  const lower = String(text || "").toLowerCase();
  const words = transcriptWords(text);
  let score = words.length ? 1 : -10;
  if (/\b(inaudible|blank[_ ]audio|thank you for watching)\b/i.test(lower)) score -= 4;
  if (/\b([a-z]+)(?:\s+\1){2,}\b/i.test(lower)) score -= 2;
  for (const phrase of phrases || []) {
    const normalized = String(phrase).toLowerCase();
    if (normalized.length >= 4 && lower.includes(normalized)) score += 1.5;
  }
  return score;
}

export function chooseTranscript(candidates, { audioQuality = "good", contextPhrases = [] } = {}) {
  const observed = (candidates || []).map((item) => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const unique = [...new Set(observed)];
  if (!unique.length) return { text: "", alternatives: [], agreement: 0, confidence: 0, needsReview: true };
  if (observed.length >= 2 && unique.length === 1) {
    const confidence = audioQuality === "good" ? 0.96 : audioQuality === "fair" ? 0.79 : 0.58;
    return { text: unique[0], alternatives: [], agreement: 1, confidence, needsReview: audioQuality === "poor" };
  }
  if (unique.length === 1) {
    const confidence = audioQuality === "good" ? 0.74 : audioQuality === "fair" ? 0.62 : 0.45;
    return { text: unique[0], alternatives: [], agreement: 1, confidence, needsReview: audioQuality !== "good" };
  }
  const agreement = transcriptAgreement(unique[0], unique[1]);
  const ranked = unique.map((text, index) => ({ text, index, score: candidateScore(text, contextPhrases) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0].text;
  const audioFactor = audioQuality === "good" ? 1 : audioQuality === "fair" ? 0.82 : 0.62;
  // Agreement is the strongest evidence available without pretending that
  // Whisper exposes calibrated truth probabilities. Divergent passes stay
  // visibly uncertain even when the recording itself is clean.
  const confidence = Number(Math.min(0.97, audioFactor * (0.38 + agreement * 0.58)).toFixed(2));
  return {
    text: selected, alternatives: unique.filter((item) => item !== selected), agreement,
    confidence, needsReview: audioQuality === "poor" || agreement < 0.78 || confidence < 0.68
  };
}

export function parseWhisperStreamLine(line) {
  const clean = String(line || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  const timestamped = clean.match(/^\[[^\]\r\n]{1,100}\]\s*(.+)$/);
  if (!timestamped) return "";
  const text = timestamped[1].trim();
  if (!text || /^(?:\[|\()(?:blank_audio|silence|music|noise|inaudible)(?:\]|\))$/i.test(text)) return "";
  return text.slice(0, MAX_TRANSCRIPT_EVENT);
}

export function sanitizeVoiceEvent(event) {
  if (!event || typeof event !== "object") return null;
  const type = ["ready", "partial", "transcript", "rejected", "restarting", "error", "stopped"].includes(event.type) ? event.type : "";
  if (!type) return null;
  return {
    type,
    ...(typeof event.text === "string" ? { text: event.text.slice(0, MAX_TRANSCRIPT_EVENT) } : {}),
    ...(typeof event.error === "string" ? { error: event.error.slice(0, 500) } : {}),
    ...(typeof event.culture === "string" ? { culture: event.culture.slice(0, 40) } : {}),
    ...(typeof event.recognizer === "string" ? { recognizer: event.recognizer.slice(0, 200) } : {}),
    ...(typeof event.engine === "string" ? { engine: event.engine.slice(0, 40) } : {}),
    ...(Number.isFinite(event.attempt) ? { attempt: Math.max(1, Math.min(MAX_LISTENER_RESTARTS, Math.trunc(event.attempt))) } : {}),
    ...(Number.isFinite(event.delayMs) ? { delayMs: Math.max(0, Math.min(30_000, Math.trunc(event.delayMs))) } : {}),
    ...(Number.isFinite(event.confidence) ? { confidence: Math.max(0, Math.min(1, event.confidence)) } : {})
  };
}

export class DesktopVoiceService extends EventEmitter {
  constructor({ userDataPath, downloadsPath, helperPath, whisperRoot = "", piperRoot = "", platform = process.platform }) {
    super();
    this.userDataPath = path.resolve(userDataPath);
    this.downloadsPath = path.resolve(downloadsPath);
    this.helperPath = path.resolve(helperPath);
    this.whisperRoot = whisperRoot ? path.resolve(whisperRoot) : "";
    this.piperRoot = piperRoot ? path.resolve(piperRoot) : "";
    this.platform = platform;
    this.settingsPath = path.join(this.userDataPath, "voice.json");
    this.listener = null;
    this.listenerEngine = "";
    this.listenerStopping = false;
    this.listenerPoll = null;
    this.listenerOutput = "";
    this.listenerSession = null;
    this.desiredListening = false;
    this.listeningOptions = { culture: "", wakeWord: "evolve", sensitivity: "high", captureDevice: -1 };
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.closed = false;
    this.synthesizer = null;
    this.diagnostics = {
      state: "idle",
      mode: "",
      microphone: "",
      startedAt: "",
      lastTranscriptAt: "",
      lastTranscript: "",
      transcriptCount: 0,
      lastConfidence: null,
      lastAgreement: null,
      lastAudio: null,
      lastNeedsReview: false,
      lastError: "",
      devices: [],
      sensitivity: "high",
      vadThreshold: VAD_THRESHOLDS.high,
      restartAttempt: 0
    };
    this.configured = this.#readSettings();
  }

  #readSettings() {
    try {
      const value = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return {
        runtime: String(value.runtime || ""),
        model: String(value.model || ""),
        whisperRoot: String(value.whisperRoot || ""),
        whisperModel: String(value.whisperModel || "")
      };
    } catch {
      return { runtime: "", model: "", whisperRoot: "", whisperModel: "" };
    }
  }

  #activeWhisperRoot() {
    return this.configured.whisperRoot || this.whisperRoot;
  }

  #writeSettings() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const temporary = `${this.settingsPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.configured, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.settingsPath);
  }

  status() {
    const piper = discoverPiperAssets({
      downloadsPath: this.downloadsPath,
      bundledRoot: this.piperRoot,
      configured: this.configured,
      platform: this.platform
    });
    const whisper = discoverWhisperAssets(this.#activeWhisperRoot(), this.platform, this.whisperRoot, this.configured.whisperModel);
    return {
      desktop: true,
      listening: Boolean(this.listener),
      desiredListening: this.desiredListening,
      recognition: {
        ready: whisper.transcriptionReady || whisper.ready,
        engine: whisper.ready
          ? "Whisper.cpp"
          : (this.platform === "win32" ? "Windows speech fallback" : "Whisper.cpp runtime required"),
        model: whisper.model ? path.basename(whisper.model) : "",
        modelTier: whisper.modelTier,
        missing: whisper.missing
      },
      diagnostics: { ...this.diagnostics },
      piper: {
        ready: piper.ready,
        runtime: piper.runtime ? path.basename(piper.runtime) : "",
        model: piper.model ? path.basename(piper.model) : "",
        config: piper.config ? path.basename(piper.config) : "",
        missing: piper.missing
      }
    };
  }

  configurePiper({ runtime, model }) {
    if (runtime !== undefined) {
      const value = existingFile(runtime);
      const acceptedNames = new Set(["piper", "piper.exe"]);
      if (!value || !acceptedNames.has(path.basename(value).toLowerCase())) {
        throw new Error("Choose the Piper runtime named piper (or piper.exe on Windows).");
      }
      this.configured.runtime = value;
    }
    if (model !== undefined) {
      const value = existingFile(model, ".onnx");
      if (!value) throw new Error("Choose a valid Piper .onnx voice model.");
      this.configured.model = value;
    }
    this.#writeSettings();
    return this.status();
  }

  configureWhisperRoot(root) {
    const resolved = root ? path.resolve(root) : "";
    let isDirectory = false;
    try { isDirectory = Boolean(resolved && fs.statSync(resolved).isDirectory()); } catch {}
    if (!isDirectory) throw new Error("Choose the folder containing Whisper.cpp and ggml-base.en.bin.");
    const whisper = discoverWhisperAssets(resolved, this.platform, this.whisperRoot, this.configured.whisperModel);
    if (!whisper.transcriptionReady) {
      throw new Error(`Whisper still needs: ${whisper.missing.join(", ") || "whisper-cli and ggml-base.en.bin"}.`);
    }
    this.configured.whisperRoot = resolved;
    this.#writeSettings();
    return this.status();
  }

  configureWhisperModel(modelPath) {
    const model = existingFile(modelPath, ".bin");
    if (!model || !/^ggml-(?!silero|vad)[a-z0-9._-]+\.bin$/i.test(path.basename(model))) {
      throw new Error("Choose a Whisper.cpp model named ggml-*.bin.");
    }
    this.configured.whisperModel = model;
    this.#writeSettings();
    return this.status();
  }

  async transcribeAudio(audio, options = {}) {
    const whisper = discoverWhisperAssets(this.#activeWhisperRoot(), this.platform, this.whisperRoot, this.configured.whisperModel);
    if (!whisper.transcriptionReady) throw new Error("Bundled Whisper transcription is unavailable.");
    const wav = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (wav.length < 44 || wav.length > MAX_PUSH_TO_TALK_WAV) throw new Error("Push-to-talk audio has an invalid size.");
    const prepared = prepareVoiceWav(wav);
    const vocabulary = sanitizeHearingTerms(Array.isArray(options?.vocabulary) ? options.vocabulary : [], 30);
    const contextPhrases = sanitizeHearingTerms(Array.isArray(options?.contextPhrases) ? options.contextPhrases : [], 4);
    const outputRoot = path.join(os.tmpdir(), "evolv-whisper-ptt");
    fs.mkdirSync(outputRoot, { recursive: true });
    const inputFile = path.join(outputRoot, `${randomUUID()}.wav`);
    fs.writeFileSync(inputFile, prepared.wav, { mode: 0o600 });
    try {
      const first = await this.#runWhisperPass(whisper, inputFile, buildHearingPrompt({ vocabulary, contextPhrases }), false);
      const useSecondPass = options?.multiPass !== false && prepared.analysis.processedDurationMs <= 30_000;
      const second = useSecondPass
        ? await this.#runWhisperPass(whisper, inputFile, buildHearingPrompt({ vocabulary, contextPhrases, enhanced: true }), true)
        : "";
      const decision = chooseTranscript([first, second], { audioQuality: prepared.analysis.quality, contextPhrases });
      this.diagnostics.lastTranscript = decision.text.slice(0, 500);
      this.diagnostics.lastTranscriptAt = new Date().toISOString();
      this.diagnostics.lastConfidence = decision.confidence;
      this.diagnostics.lastAgreement = decision.agreement;
      this.diagnostics.lastAudio = prepared.analysis;
      this.diagnostics.lastNeedsReview = decision.needsReview;
      if (decision.text) this.diagnostics.transcriptCount += 1;
      return {
        text: decision.text,
        alternatives: decision.alternatives,
        confidence: decision.confidence,
        confidenceSource: "audio-quality-and-pass-agreement",
        agreement: decision.agreement,
        needsReview: decision.needsReview,
        audio: prepared.analysis,
        hearing: { passes: useSecondPass ? 2 : 1, vocabularyTerms: vocabulary.length, contextPhrases: contextPhrases.length },
        engine: "whisper.cpp",
        model: path.basename(whisper.model),
        modelTier: whisper.modelTier
      };
    } finally {
      try { fs.rmSync(inputFile, { force: true }); } catch {}
    }
  }

  async #runWhisperPass(whisper, inputFile, prompt, enhanced) {
    const child = spawn(whisper.cliRuntime, [
      "-m", whisper.model,
      "-f", inputFile,
      "-t", String(Math.max(2, Math.min(6, os.cpus().length - 1))),
      "-l", "en", "-nt", "-np", "-ng", "-sns",
      "-bo", enhanced ? "7" : "5",
      "-bs", enhanced ? "7" : "5",
      "-nth", enhanced ? "0.50" : "0.60",
      "--prompt", prompt
    ], { cwd: path.dirname(whisper.cliRuntime), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Whisper took too long to transcribe the recording."));
      }, 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode !== 0) throw new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || "Whisper could not transcribe the recording.");
    return stdout.replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[[^\]\r\n]{1,100}\]/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_EVENT);
  }

  startListening({ culture = "", wakeWord = "evolve", sensitivity = "high", captureDevice = -1 } = {}) {
    this.closed = false;
    this.desiredListening = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const normalizedSensitivity = Object.hasOwn(VAD_THRESHOLDS, sensitivity) ? sensitivity : "high";
    const normalizedCapture = Number.isInteger(Number(captureDevice))
      ? Math.max(-1, Math.min(31, Number(captureDevice))) : -1;
    this.listeningOptions = {
      culture: String(culture || "").slice(0, 40),
      wakeWord: String(wakeWord || "evolve").slice(0, 32),
      sensitivity: normalizedSensitivity,
      captureDevice: normalizedCapture
    };
    if (this.listener) return this.status();
    const whisper = discoverWhisperAssets(this.#activeWhisperRoot(), this.platform, this.whisperRoot, this.configured.whisperModel);
    if (whisper.ready) return this.#startWhisperListening(whisper, this.listeningOptions);
    if (this.platform !== "win32") {
      throw new Error("Install a Linux Whisper.cpp runtime to use local listening.");
    }
    return this.#startWindowsListening(this.listeningOptions.culture);
  }

  #startWhisperListening(whisper, options) {
    const { wakeWord, sensitivity, captureDevice } = options;
    const prompt = String(wakeWord || "evolve").toLowerCase().replace(/[^a-z0-9 '-]/g, "").trim().slice(0, 32) || "evolve";
    const streamMode = whisper.mode === "stream";
    const vadThreshold = VAD_THRESHOLDS[sensitivity] || VAD_THRESHOLDS.high;
    this.diagnostics = {
      ...this.diagnostics,
      state: "starting",
      mode: streamMode ? "continuous-vad" : "wake-command",
      startedAt: new Date().toISOString(),
      lastError: "",
      sensitivity,
      vadThreshold,
      restartAttempt: this.restartAttempt
    };
    const outputRoot = path.join(os.tmpdir(), "evolv-whisper");
    fs.mkdirSync(outputRoot, { recursive: true });
    const outputFile = path.join(outputRoot, `${randomUUID()}.txt`);
    fs.writeFileSync(outputFile, "", { mode: 0o600 });
    const commonArgs = [
      "-m", whisper.model,
      "-f", outputFile,
      "-t", String(Math.max(2, Math.min(6, os.cpus().length - 1))),
      "-l", "en",
      "-ng",
      ...(captureDevice >= 0 ? ["-c", String(captureDevice)] : [])
    ];
    const child = spawn(whisper.runtime, streamMode
      ? [...commonArgs, "--step", "0", "--length", "8000", "-vth", String(vadThreshold), "-fth", "80", "-nf"]
      : [...commonArgs, "-p", prompt, "-pms", "2500", "-cms", "7000", "-mt", "64", "-vth", String(vadThreshold), "-fth", "80"],
    { cwd: path.dirname(whisper.runtime), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    this.listener = child;
    this.listenerEngine = "whisper";
    this.listenerStopping = false;
    this.listenerOutput = outputFile;
    const session = { child, outputFile, poll: null, stableTimer: null, intentional: false, cleaned: false };
    this.listenerSession = session;
    let offset = 0;
    let remainder = "";
    let stderr = "";
    let readySent = false;
    let lastTranscript = "";
    let lastTranscriptAt = 0;
    const announceReady = () => {
      if (readySent || this.listener !== child) return;
      readySent = true;
      this.diagnostics.state = "listening";
      session.stableTimer = setTimeout(() => {
        if (this.listenerSession !== session || this.listener !== child) return;
        this.restartAttempt = 0;
        this.diagnostics.restartAttempt = 0;
      }, 30_000);
      session.stableTimer.unref?.();
      this.emit("event", sanitizeVoiceEvent({
        type: "ready",
        culture: "en",
        recognizer: "Whisper.cpp · base.en",
        engine: "whisper.cpp"
      }));
    };
    const pollCommands = () => {
      if (this.listener !== child || !fs.existsSync(outputFile)) return;
      try {
        const data = fs.readFileSync(outputFile);
        if (data.length < offset) offset = 0;
        remainder += data.subarray(offset).toString("utf8");
        offset = data.length;
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() || "";
        for (const line of lines) {
          const recognized = streamMode
            ? parseWhisperStreamLine(line)
            : line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_EVENT - 7);
          const transcript = streamMode ? recognized : (recognized ? `Evolve ${recognized}` : "");
          const normalized = transcript.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const duplicate = normalized && normalized === lastTranscript && Date.now() - lastTranscriptAt < 5_000;
          if (transcript && !duplicate) {
            lastTranscript = normalized;
            lastTranscriptAt = Date.now();
            this.diagnostics.lastTranscript = transcript.slice(0, 500);
            this.diagnostics.lastTranscriptAt = new Date().toISOString();
            this.diagnostics.transcriptCount += 1;
            this.emit("event", sanitizeVoiceEvent({
            type: "transcript",
            text: transcript,
            confidence: 1,
            engine: "whisper.cpp"
            }));
          }
        }
      } catch {}
    };
    session.poll = setInterval(pollCommands, 250);
    session.poll.unref?.();
    this.listenerPoll = session.poll;
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (/Speech detected/i.test(text)) this.emit("event", sanitizeVoiceEvent({ type: "partial", text: "Speech detected · processing locally", engine: "whisper.cpp" }));
      if (/The prompt is:|\[Start speaking\]/i.test(text)) announceReady();
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-4_000);
      const devices = [...stderr.matchAll(/Capture device #(\d+):\s*'([^']+)'/g)]
        .map((match) => ({ id: Number(match[1]), name: match[2].slice(0, 300) }))
        .filter((device, index, values) => values.findIndex((item) => item.id === device.id) === index);
      if (devices.length) {
        this.diagnostics.devices = devices;
        const selected = devices.find((device) => device.id === captureDevice) || devices[0];
        this.diagnostics.microphone = selected.name;
      }
      if (/always-prompt mode|using VAD|obtained spec for input device/i.test(text)) announceReady();
    });
    child.once("error", (error) => {
      this.diagnostics.state = "error";
      this.diagnostics.lastError = error.message.slice(0, 500);
    });
    child.once("exit", (code) => {
      pollCommands();
      const current = this.listenerSession === session;
      const stopping = session.intentional || !this.desiredListening || !current;
      if (this.listener === child) this.listener = null;
      this.#cleanupListenerSession(session);
      if (!stopping) {
        const useful = stderr.split(/\r?\n/).filter((line) => /error|failed/i.test(line)).slice(-3).join(" ");
        this.#scheduleListenerRestart(useful || `Whisper.cpp stopped unexpectedly${Number.isInteger(code) ? ` (code ${code})` : ""}.`);
      } else if (current && !this.listener) {
        this.diagnostics.state = "stopped";
        this.emit("event", sanitizeVoiceEvent({ type: "stopped", engine: "whisper.cpp" }));
      }
    });
    return this.status();
  }

  #startWindowsListening(culture = "") {
    if (this.platform !== "win32") throw new Error("Windows speech recognition is unavailable on this platform.");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(powershell) || !fs.existsSync(this.helperPath)) throw new Error("Windows offline speech recognition is unavailable.");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.helperPath];
    if (culture) args.push("-Culture", String(culture).slice(0, 40));
    const child = spawn(powershell, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.listener = child;
    this.listenerEngine = "windows";
    this.listenerStopping = false;
    const session = { child, outputFile: "", poll: null, stableTimer: null, intentional: false, cleaned: false };
    this.listenerSession = session;
    this.diagnostics = {
      ...this.diagnostics,
      state: "starting",
      mode: "windows-speech",
      startedAt: new Date().toISOString(),
      lastError: "",
      restartAttempt: this.restartAttempt
    };
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    lines.on("line", (line) => {
      try {
        const event = sanitizeVoiceEvent(JSON.parse(line));
        if (event) {
          if (event.type === "ready") {
            this.diagnostics.state = "listening";
            session.stableTimer = setTimeout(() => {
              if (this.listenerSession !== session || this.listener !== child) return;
              this.restartAttempt = 0;
              this.diagnostics.restartAttempt = 0;
            }, 30_000);
            session.stableTimer.unref?.();
          }
          this.emit("event", event);
        }
      } catch {}
    });
    child.once("error", (error) => {
      this.diagnostics.state = "error";
      this.diagnostics.lastError = error.message.slice(0, 500);
    });
    child.once("exit", (code) => {
      lines.close();
      const current = this.listenerSession === session;
      const stopping = session.intentional || !this.desiredListening || !current;
      if (this.listener === child) this.listener = null;
      this.#cleanupListenerSession(session);
      if (!stopping) {
        this.#scheduleListenerRestart(stderr.trim() || `Windows speech recognition stopped unexpectedly${Number.isInteger(code) ? ` (code ${code})` : ""}.`);
      } else if (current && !this.listener) {
        this.diagnostics.state = "stopped";
        this.emit("event", sanitizeVoiceEvent({ type: "stopped", engine: "windows" }));
      }
    });
    return this.status();
  }

  #cleanupListenerSession(session) {
    if (!session || session.cleaned) return;
    session.cleaned = true;
    if (session.poll) clearInterval(session.poll);
    if (session.stableTimer) clearTimeout(session.stableTimer);
    if (session.outputFile) {
      try { fs.rmSync(session.outputFile, { force: true }); } catch {}
    }
    if (this.listenerSession === session) {
      this.listenerSession = null;
      this.listenerPoll = null;
      this.listenerOutput = "";
      this.listenerEngine = "";
      this.listenerStopping = false;
    }
  }

  #scheduleListenerRestart(reason) {
    if (!this.desiredListening || this.closed) return;
    clearTimeout(this.restartTimer);
    if (this.restartAttempt >= MAX_LISTENER_RESTARTS) {
      this.desiredListening = false;
      this.diagnostics.state = "error";
      this.diagnostics.lastError = `Live listening stopped after ${MAX_LISTENER_RESTARTS} recovery attempts. ${reason}`.slice(0, 500);
      this.emit("event", sanitizeVoiceEvent({ type: "error", error: this.diagnostics.lastError, engine: "voice" }));
      this.emit("event", sanitizeVoiceEvent({ type: "stopped", engine: "voice" }));
      return;
    }
    this.restartAttempt += 1;
    const delayMs = 750 * (2 ** (this.restartAttempt - 1));
    this.diagnostics.state = "restarting";
    this.diagnostics.lastError = String(reason || "Listener stopped unexpectedly.").slice(0, 500);
    this.diagnostics.restartAttempt = this.restartAttempt;
    this.emit("event", sanitizeVoiceEvent({
      type: "restarting",
      attempt: this.restartAttempt,
      delayMs,
      error: this.diagnostics.lastError,
      engine: "voice"
    }));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredListening || this.closed || this.listener) return;
      try {
        const whisper = discoverWhisperAssets(this.#activeWhisperRoot(), this.platform, this.whisperRoot, this.configured.whisperModel);
        if (whisper.ready) this.#startWhisperListening(whisper, this.listeningOptions);
        else if (this.platform === "win32") this.#startWindowsListening(this.listeningOptions.culture);
        else throw new Error("Install a Linux Whisper.cpp runtime to use local listening.");
      } catch (error) {
        this.#scheduleListenerRestart(error.message);
      }
    }, delayMs);
    this.restartTimer.unref?.();
  }

  stopListening() {
    this.desiredListening = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAttempt = 0;
    const child = this.listener;
    const session = this.listenerSession;
    if (!child) {
      this.#cleanupListenerSession(session);
      this.diagnostics.state = "stopped";
      this.diagnostics.restartAttempt = 0;
      return this.status();
    }
    const engine = this.listenerEngine;
    this.listenerStopping = true;
    if (session) session.intentional = true;
    this.listener = null;
    this.#cleanupListenerSession(session);
    if (engine === "windows") {
      try { child.stdin.end("stop\n"); } catch {}
    } else {
      try { child.kill(); } catch {}
    }
    const timer = setTimeout(() => { if (child.exitCode == null) child.kill(); }, 1_500);
    timer.unref?.();
    this.diagnostics.state = "stopped";
    this.diagnostics.restartAttempt = 0;
    return this.status();
  }

  async synthesize(text, rate = 1) {
    const content = String(text || "").trim().slice(0, MAX_TTS_TEXT);
    if (!content) throw new Error("There is no text to speak.");
    const piper = discoverPiperAssets({
      downloadsPath: this.downloadsPath,
      bundledRoot: this.piperRoot,
      configured: this.configured,
      platform: this.platform
    });
    if (!piper.ready) throw Object.assign(new Error(`Piper needs: ${piper.missing.join(", ")}.`), { code: "PIPER_NOT_READY" });
    this.stopSpeaking();
    const outputRoot = path.join(os.tmpdir(), "evolv-piper");
    fs.mkdirSync(outputRoot, { recursive: true });
    const outputFile = path.join(outputRoot, `${randomUUID()}.wav`);
    const lengthScale = Math.max(0.5, Math.min(2, 1 / (Number(rate) || 1)));
    const child = spawn(piper.runtime, [
      "--model", piper.model,
      "--config", piper.config,
      "--output_file", outputFile,
      "--length_scale", String(lengthScale)
    ], {
      cwd: path.dirname(piper.runtime),
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      shell: false
    });
    this.synthesizer = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.stdin.end(`${content}\n`);
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Piper took too long to create speech."));
      }, 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    }).finally(() => { if (this.synthesizer === child) this.synthesizer = null; });
    try {
      if (exitCode !== 0 || !fs.existsSync(outputFile)) throw new Error(stderr.trim() || "Piper could not create speech.");
      const audio = fs.readFileSync(outputFile);
      if (audio.length < 44 || audio.length > 100 * 1024 * 1024) throw new Error("Piper returned an invalid audio file.");
      return { audioBase64: audio.toString("base64"), format: "audio/wav", engine: "piper" };
    } finally {
      try { fs.rmSync(outputFile, { force: true }); } catch {}
    }
  }

  stopSpeaking() {
    if (this.synthesizer && !this.synthesizer.killed) this.synthesizer.kill();
    this.synthesizer = null;
  }

  close() {
    this.closed = true;
    this.stopListening();
    this.stopSpeaking();
  }
}
