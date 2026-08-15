import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEvolvLocalService, createPullProgress } from "../lib/evolv-local.mjs";
import { createOllamaClient } from "../lib/ollama-client.mjs";
import { buildModelfile, evolvModelDefinition, isEvolvModel, EVOLV_SYSTEM_PROMPT } from "../lib/evolv-models.mjs";

const BASE = evolvModelDefinition().base;

// A stand-in for the Ollama client: scripted model lists, recorded calls, and
// no network. The real client is exercised separately against a fake fetch,
// and the whole flow is exercised against the mock server in
// evolv-local-server.test.mjs.
function fakeClient({ models = [], version = "0.5.0", unreachable = false, onPull, onCreate, storedPrompt = EVOLV_SYSTEM_PROMPT } = {}) {
  let installed = [...models];
  const calls = [];
  const unreachableError = () => Object.assign(new Error("Ollama stopped responding. Start Ollama and try again."), { code: "OLLAMA_UNREACHABLE" });
  return {
    calls,
    installed: () => installed,
    async version() {
      if (unreachable) throw unreachableError();
      return version;
    },
    async listModels() {
      if (unreachable) throw unreachableError();
      return installed.map((name) => ({ name, size: 10, digest: name, parameterSize: "3B" }));
    },
    async pull(model, { onEvent, signal } = {}) {
      calls.push(["pull", model]);
      await onPull?.({ onEvent, signal });
      onEvent?.({ status: "pulling manifest" });
      onEvent?.({ status: "pulling layer", digest: "sha256:one", total: 1000, completed: 1000 });
      installed = [...installed, model];
    },
    async create(name, definition, { onEvent } = {}) {
      calls.push(["create", name, definition.base]);
      await onCreate?.();
      onEvent?.({ status: "writing manifest" });
      installed = [...installed, name];
      storedPrompt = definition.system;
    },
    async show() {
      calls.push(["show"]);
      return storedPrompt === null ? null : { system: storedPrompt };
    }
  };
}

test("Ollama unreachable is reported as unreachable, not as empty", async () => {
  const status = await createEvolvLocalService({ client: fakeClient({ unreachable: true }) }).status();

  assert.equal(status.ollamaReachable, false);
  assert.equal(status.modelCount, 0);
  // The distinction the whole feature turns on: no models because nothing
  // answered is not the same state as no models because none are installed,
  // and only one of them is fixed by installing something.
  assert.equal(status.evolvModelInstalled, false);
  assert.equal(status.baseModelInstalled, false);
});

test("Ollama reachable with zero models is not a ready state", async () => {
  const status = await createEvolvLocalService({ client: fakeClient({ models: [] }) }).status();

  assert.equal(status.ollamaReachable, true);
  assert.equal(status.modelCount, 0);
  assert.deepEqual(status.models, []);
  assert.equal(status.evolvModelInstalled, false);
  assert.equal(status.evolvModel, "evolv:latest");
});

test("models installed by hand are reported and never disturbed", async () => {
  const status = await createEvolvLocalService({ client: fakeClient({ models: ["qwen2.5:7b", "mistral:latest"] }) }).status();

  assert.equal(status.modelCount, 2);
  assert.deepEqual(status.models, ["qwen2.5:7b", "mistral:latest"]);
  assert.equal(status.evolvModelInstalled, false, "Evolv Local is missing, but these still work");
});

test("evolv:latest present reports ready", async () => {
  const status = await createEvolvLocalService({ client: fakeClient({ models: [BASE, "evolv:latest"] }) }).status();

  assert.equal(status.evolvModelInstalled, true);
  assert.equal(status.baseModelInstalled, true);
  assert.equal(status.evolvModelLabel, "Evolv Local");
});

test("a model built from an older prompt is flagged, and rebuilding clears it", async () => {
  // Editing the system prompt does not change a model Ollama already built.
  // Without this, an improved prompt would reach only new installs and the
  // prompt would be un-editable in practice.
  const client = fakeClient({ models: [BASE, "evolv:latest"], storedPrompt: "an older set of instructions" });
  const service = createEvolvLocalService({ client });

  const before = await service.status();
  assert.equal(before.evolvModelInstalled, true);
  assert.equal(before.evolvModelStale, true);

  const run = service.install();
  await run.done;
  assert.deepEqual(client.calls.filter(([name]) => name === "pull"), [], "a rebuild downloads nothing");

  const after = await service.status();
  assert.equal(after.evolvModelStale, false);
});

test("a current model is not called stale, and is only asked once", async () => {
  const client = fakeClient({ models: [BASE, "evolv:latest"] });
  const service = createEvolvLocalService({ client });

  assert.equal((await service.status()).evolvModelStale, false);
  await service.status();
  await service.status();
  // Status is polled; a model that has not been rebuilt cannot have changed.
  assert.equal(client.calls.filter(([name]) => name === "show").length, 1);
});

test("a model that cannot be inspected is left alone rather than called stale", async () => {
  // Sending someone to rebuild a working model because one request failed is
  // worse than saying nothing.
  const client = fakeClient({ models: [BASE, "evolv:latest"], storedPrompt: null });
  assert.equal((await createEvolvLocalService({ client }).status()).evolvModelStale, false);
});

test("whitespace is not a reason to rebuild", async () => {
  const client = fakeClient({
    models: [BASE, "evolv:latest"],
    storedPrompt: `  ${EVOLV_SYSTEM_PROMPT.replace(/\n/g, "\n ")}\n`
  });
  assert.equal((await createEvolvLocalService({ client }).status()).evolvModelStale, false);
});

test("the build offered is the largest this computer can hold", async () => {
  const { recommendEvolvModel, evolvModelDefinition, listEvolvModels } = await import("../lib/evolv-models.mjs");
  const GB = 1e9;

  // A model that technically loads and then swaps is how people conclude local
  // AI is useless, so a variant is only offered when it fits comfortably.
  assert.equal(recommendEvolvModel(4 * GB), "evolv:latest");
  assert.equal(recommendEvolvModel(8 * GB), "evolv:pro");
  assert.equal(recommendEvolvModel(16 * GB), "evolv:max");
  assert.equal(recommendEvolvModel(64 * GB), "evolv:max");
  // Never nothing: a machine too small even for the smallest is a fact the
  // memory warning states, not a reason to offer no assistant at all.
  assert.equal(recommendEvolvModel(0), "evolv:latest");
  assert.equal(recommendEvolvModel(1 * GB), "evolv:latest");

  // Every variant is the same assistant — only the base differs, because that
  // is what decides how good it feels.
  const catalogue = listEvolvModels();
  assert.equal(catalogue.length, 3);
  assert.equal(new Set(catalogue.map((entry) => entry.system)).size, 1, "one prompt across the ladder");
  assert.equal(new Set(catalogue.map((entry) => entry.base)).size, 3, "three different bases");
  for (const entry of catalogue) assert.ok(entry.approximateBytes > 0, `${entry.name} states its size`);

  // The default keeps the base it has always had: re-pointing it would change
  // what is already installed on someone's laptop without asking.
  assert.equal(evolvModelDefinition("evolv:latest").base, "llama3.2:3b");
});

test("a model pulled without a tag still counts as installed", async () => {
  // `ollama pull evolv` and `ollama pull evolv:latest` leave different strings
  // in /api/tags for the same model.
  const status = await createEvolvLocalService({ client: fakeClient({ models: ["evolv"] }) }).status();
  assert.equal(status.evolvModelInstalled, true);
});

test("the pull progress parser adds up layers and never invents a percentage", () => {
  const apply = createPullProgress();

  // Before any byte counts arrive there is no honest percentage to show.
  assert.deepEqual(apply({ status: "pulling manifest" }), { status: "pulling manifest", completed: 0, total: 0, percent: null });

  apply({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 250 });
  const two = apply({ status: "pulling b", digest: "sha256:b", total: 1000, completed: 250 });
  assert.deepEqual(two, { status: "pulling b", completed: 500, total: 2000, percent: 25 });

  // A layer re-reported at a higher figure replaces its earlier one rather than
  // stacking, so the bar cannot exceed the download or run backwards.
  const later = apply({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 1000 });
  assert.deepEqual(later, { status: "pulling a", completed: 1250, total: 2000, percent: 62 });
});

test("installing pulls the base model, then builds evolv:latest from it", async () => {
  const client = fakeClient({ models: [] });
  const service = createEvolvLocalService({ client });
  const phases = [];

  const run = service.install();
  run.subscribe((snapshot) => phases.push(snapshot.phase));
  await run.done;

  assert.deepEqual(client.calls, [["pull", BASE], ["create", "evolv:latest", BASE]], "in that order");
  assert.deepEqual([...new Set(phases)], ["checking", "pulling", "creating", "ready"]);
  assert.equal((await service.status()).evolvModelInstalled, true);
});

test("a base model that is already downloaded is never downloaded again", async () => {
  // The retry path after a create failure. Re-fetching several gigabytes to
  // rerun a step that takes a second is the difference between a retry someone
  // waits for and one they abandon.
  const client = fakeClient({ models: [BASE] });
  const service = createEvolvLocalService({ client });

  const run = service.install();
  const seen = [];
  run.subscribe((snapshot) => seen.push(snapshot.status));
  await run.done;

  assert.deepEqual(client.calls, [["create", "evolv:latest", BASE]]);
  assert.ok(seen.some((status) => /already downloaded/i.test(status)), "and it says so");
});

test("a failed download is reported plainly, with the real reason kept for detail", async () => {
  const client = fakeClient({
    models: [],
    onPull: () => { throw Object.assign(new Error("max retries exceeded: connection reset"), { code: "OLLAMA_STREAM_ERROR" }); }
  });
  const service = createEvolvLocalService({ client });

  const run = service.install();
  await run.done;
  const snapshot = run.snapshot();

  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.error.message, "Evolv Local couldn't finish downloading.");
  assert.match(snapshot.error.detail, /connection reset/, "the useful text survives for the details toggle");
  assert.equal((await service.status()).evolvModelInstalled, false, "and nothing pretends it worked");
});

test("Ollama disappearing mid-install says so in words that name the fix", async () => {
  const client = fakeClient({
    models: [],
    onPull: () => { throw Object.assign(new Error("fetch failed"), { code: "OLLAMA_UNREACHABLE" }); }
  });
  const run = createEvolvLocalService({ client }).install();
  await run.done;

  assert.equal(run.snapshot().error.message, "Ollama stopped responding. Start Ollama and try again.");
});

test("a create that reports success but produces nothing is not called ready", async () => {
  const client = fakeClient({ models: [BASE] });
  client.create = async () => { client.calls.push(["create"]); };  // succeeds, installs nothing
  const run = createEvolvLocalService({ client }).install();
  await run.done;

  assert.equal(run.snapshot().phase, "error");
  assert.match(run.snapshot().error.detail, /did not report evolv:latest/);
});

test("a second install joins the one already running", async () => {
  let release;
  const client = fakeClient({ models: [], onPull: () => new Promise((resolve) => { release = resolve; }) });
  const service = createEvolvLocalService({ client });

  const first = service.install();
  const second = service.install();
  assert.equal(second.done, first.done, "the same run, not a second download");

  while (first.snapshot().phase !== "pulling") await new Promise((resolve) => setImmediate(resolve));

  // A window reopened mid-download is handed the state as it stands now, rather
  // than waiting for the next byte to learn anything.
  let firstSeen = null;
  const third = service.install();
  third.subscribe((snapshot) => { firstSeen ??= snapshot; });
  assert.equal(firstSeen.phase, "pulling");

  release();
  await first.done;
  assert.equal(client.calls.filter(([name]) => name === "pull").length, 1);
});

test("an install can be cancelled and leaves nothing behind", async () => {
  const client = fakeClient({
    models: [],
    onPull: ({ signal }) => new Promise((resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop);
    })
  });
  const service = createEvolvLocalService({ client });

  const run = service.install();
  assert.equal(service.cancel(), true);
  await run.done;

  assert.equal(run.snapshot().phase, "idle");
  assert.equal(run.snapshot().cancelled, true);
  assert.equal((await service.status()).evolvModelInstalled, false);
  assert.equal(service.cancel(), false, "nothing left to cancel");
});

test("an unknown Evolv model is refused by name rather than half-installed", () => {
  const service = createEvolvLocalService({ client: fakeClient() });
  assert.throws(() => service.install({ model: "evolv:imaginary" }), (error) => error.status === 404);
  assert.equal(isEvolvModel("evolv:latest"), true);
  assert.equal(isEvolvModel("llama3.2:3b"), false, "a user's own model is not one of ours");
});

test("the Modelfile carries the system prompt and the parameters", () => {
  const definition = evolvModelDefinition();
  const modelfile = buildModelfile(definition);

  assert.match(modelfile, new RegExp(`^FROM ${definition.base}`));
  assert.match(modelfile, /PARAMETER temperature 0\.6/);
  assert.match(modelfile, /PARAMETER num_ctx 8192/);
  assert.ok(modelfile.includes(EVOLV_SYSTEM_PROMPT), "the prompt has to survive the trip intact");
  // A triple quote inside the prompt would end the SYSTEM block early and
  // silently truncate the personality.
  assert.equal(EVOLV_SYSTEM_PROMPT.includes('"""'), false);
});

test("the system prompt says the things it exists to say", () => {
  // These are commitments, not decoration: a local model that invents tool
  // results or claims it wrote a file is worse than one that says it cannot.
  assert.match(EVOLV_SYSTEM_PROMPT, /Evolv Local/);
  assert.match(EVOLV_SYSTEM_PROMPT, /Never invent the result of a tool/i);
  assert.match(EVOLV_SYSTEM_PROMPT, /Never claim you performed an action/i);
  assert.match(EVOLV_SYSTEM_PROMPT, /assumptions/i);
  assert.match(EVOLV_SYSTEM_PROMPT, /estimate/i);
  assert.match(EVOLV_SYSTEM_PROMPT, /only when they are actually offered/i);
});

test("the client falls back to a Modelfile when create rejects the structured form", async () => {
  // Ollama changed /api/create from a Modelfile string to separate fields.
  // Evolv has to build a model on either side of that change.
  const bodies = [];
  const client = createOllamaClient({
    baseUrl: "http://ollama.invalid",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (body.from) return new Response("unknown field \"from\"", { status: 400 });
      return new Response(`${JSON.stringify({ status: "success" })}\n`, { status: 200 });
    }
  });

  await client.create("evolv:latest", evolvModelDefinition());
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].modelfile, /^FROM /);
});

test("an unreachable Ollama becomes a sentence instead of a fetch error", async () => {
  const client = createOllamaClient({
    baseUrl: "http://ollama.invalid",
    fetchImpl: async () => { throw new TypeError("fetch failed"); }
  });

  await assert.rejects(() => client.listModels(), (error) => {
    assert.equal(error.message, "Ollama stopped responding. Start Ollama and try again.");
    assert.equal(error.code, "OLLAMA_UNREACHABLE");
    return true;
  });
});

test("the interface distinguishes all four states and offers the install", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="install-evolv-local"/);
  assert.match(html, /id="local-setup-progress"/);
  assert.match(html, /id="local-setup-error"/, "the underlying error needs somewhere to live");

  assert.match(app, /Ollama connected — model needed/);
  assert.match(app, /Evolv Local ready/);
  assert.match(app, /new Option\("No local models installed"/);
  // Checked against the option that is built rather than the whole file: the
  // comment above it quotes the old wording deliberately, to say why it went.
  assert.doesNotMatch(app, /new Option\("No manual models available"/, "the old wording described the dropdown, not the problem");

  // Three colours for three states; amber is the one that used to be missing.
  assert.match(css, /\.status-dot\.needs-model/);
  assert.match(app, /"needs-model"/);

  // The bar is driven by Ollama's byte counts, and shows motion rather than a
  // number when there are none yet.
  assert.match(app, /snapshot\.percent/);
  assert.match(app, /indeterminate/);

  // Rebuilding after the prompt changes, without re-downloading anything.
  assert.match(app, /Rebuild \$\{label\}/);
  // The offer names the build this machine can hold, and installs that one
  // rather than always the default.
  assert.match(app, /health\.recommendedLabel/);
  assert.match(app, /largest build this computer has memory for/);
  assert.match(app, /installButton\?\.dataset\.model/);
  // An upgrade is only mentioned when there is one, and never removes what is
  // already installed.
  assert.match(app, /health\.recommendedUpgrade/);
  assert.match(app, /leaves \$\{label\} in place/);
  assert.match(app, /older version of its instructions/);
  assert.match(app, /nothing is re-downloaded/);
});
