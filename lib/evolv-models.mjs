// The Evolv Local model catalogue.
//
// "Evolv Local" is an Ollama model Evolv builds on the user's machine: a small
// open base model with Evolv's own system prompt and generation settings baked
// in. It is not a trained model. Calling it one would be a lie, and the file
// that would have to carry that lie is this one.
//
// Everything that defines a variant lives in ENTRIES below, so adding
// evolv:lite or evolv:engineer later means adding a record here rather than
// touching the installer, the server, or the interface.

import { assessModelFit } from "./model-fit.mjs";

// Written once, here, rather than assembled from fragments elsewhere: this text
// is the whole personality of the local model, and it should be readable and
// editable as prose.
export const EVOLV_SYSTEM_PROMPT = `You are Evolv Local, the on-device assistant inside Evolv — a local-first AI workspace running on the user's own computer.

How you work:
- Think in clear technical steps. Engineering, programming, debugging, electronics, CAD and mechanical reasoning, experiments, and local AI workflows are your home ground.
- When a question is underspecified, state your assumptions and answer under them rather than stalling.
- Separate what you know from what you are estimating. Label an estimate as an estimate and say what it came from.
- Show the formula before the number, and carry units through the working.
- Never invent the result of a tool, a file, a measurement, or a command. If you did not receive it, say that you did not.
- Use Evolv's tools only when they are actually offered to you in this conversation. If the tool you want is not available, say what you would need instead of pretending to call it.
- Never claim you performed an action — wrote a file, ran a simulation, changed a setting — unless Evolv has confirmed that it succeeded.
- You are running on local hardware that may be modest. Prefer short, dense answers, and expand only when the question needs it.`;

// The base is overridable by environment so a different machine class can be
// tried without editing code or shipping a new build.
const DEFAULT_BASE = process.env.EVOLV_LOCAL_BASE_MODEL || "llama3.2:3b";

const PARAMETERS = Object.freeze({
  temperature: 0.6,
  top_p: 0.9,
  repeat_penalty: 1.1,
  num_ctx: 8192
});

// Three sizes of the same assistant. The prompt and the parameters are
// identical; only the base differs, because the thing that decides how good
// Evolv Local feels is almost entirely how much model the machine can hold.
//
// evolv:latest keeps the small base it has always had. It is the one that runs
// on anything, and re-pointing it at a larger model would change what is
// already installed on someone's laptop without asking.
const ENTRIES = {
  "evolv:latest": {
    name: "evolv:latest",
    label: "Evolv Local",
    base: DEFAULT_BASE,
    // Roughly what the base model weighs, for the "about 2 GB" the interface
    // shows before a download starts. Progress itself always uses the byte
    // counts Ollama reports; this is only ever a pre-download estimate.
    approximateBytes: 2_000_000_000,
    system: EVOLV_SYSTEM_PROMPT,
    description: "Evolv's local engineering assistant, built from a small open model on this computer.",
    parameters: PARAMETERS
  },
  "evolv:pro": {
    name: "evolv:pro",
    label: "Evolv Local Pro",
    base: process.env.EVOLV_LOCAL_PRO_BASE_MODEL || "qwen2.5:7b",
    approximateBytes: 4_700_000_000,
    system: EVOLV_SYSTEM_PROMPT,
    description: "The same assistant on a mid-sized base. Noticeably better at multi-step reasoning and tool use.",
    parameters: PARAMETERS
  },
  "evolv:max": {
    name: "evolv:max",
    label: "Evolv Local Max",
    base: process.env.EVOLV_LOCAL_MAX_BASE_MODEL || "qwen2.5:14b",
    approximateBytes: 9_000_000_000,
    system: EVOLV_SYSTEM_PROMPT,
    description: "For machines with memory to spare. The best local answers Evolv can build, and the slowest.",
    parameters: PARAMETERS
  }
};

// Which one to suggest on this machine. Largest first, and a variant is only
// suggested when it fits comfortably — a model that technically loads and then
// swaps is how people conclude local AI is useless.
//
// Never returns nothing: evolv:latest is the floor, because a machine too small
// even for that is a fact the memory warning states rather than a reason to
// offer no assistant at all.
export function recommendEvolvModel(totalMemoryBytes = 0) {
  const ladder = ["evolv:max", "evolv:pro", "evolv:latest"];
  const roomy = ladder.find((name) => assessModelFit(ENTRIES[name].approximateBytes, totalMemoryBytes).level === "ok");
  return roomy || DEFAULT_EVOLV_MODEL;
}

export const DEFAULT_EVOLV_MODEL = "evolv:latest";

export function listEvolvModels() {
  return Object.values(ENTRIES).map((entry) => ({ ...entry }));
}

export function evolvModelDefinition(name = DEFAULT_EVOLV_MODEL) {
  const entry = ENTRIES[String(name || "").toLowerCase()];
  if (!entry) {
    const known = Object.keys(ENTRIES).join(", ");
    throw Object.assign(new Error(`Unknown Evolv model "${name}". Known models: ${known}.`), {
      status: 404, code: "UNKNOWN_EVOLV_MODEL", expose: true
    });
  }
  return { ...entry };
}

// Evolv's own models are the ones this catalogue defines. A user's manually
// pulled model is never one of these, whatever it happens to be called.
export function isEvolvModel(name) {
  return Object.hasOwn(ENTRIES, String(name || "").toLowerCase());
}

// Ollama's newer create API takes the pieces separately, but older builds only
// understand a Modelfile, so both forms are produced from one definition.
export function buildModelfile(definition) {
  const lines = [`FROM ${definition.base}`];
  for (const [key, value] of Object.entries(definition.parameters || {})) {
    lines.push(`PARAMETER ${key} ${value}`);
  }
  // Triple quotes keep the newlines; the prompt contains no triple quote of its
  // own, and the test holds that.
  lines.push(`SYSTEM """${definition.system}"""`);
  return `${lines.join("\n")}\n`;
}
