// Installing Evolv Local.
//
// One install at a time, driven by a small state machine:
//
//   idle → checking → pulling → creating → ready
//                  ↘         ↘         ↘
//                        error (recoverable, see below)
//
// Two things make this more than a wrapper around two HTTP calls. A pull can
// take twenty minutes on a slow line, so progress has to be real and the run
// has to survive the interface being closed and reopened — the run lives here,
// in the server, and a reconnecting client subscribes to it rather than
// starting a second one. And a failure between the two steps is common enough
// to design for: the base model is several gigabytes, so once it is down, a
// retry must never download it again.
import { DEFAULT_EVOLV_MODEL, evolvModelDefinition, isEvolvModel } from "./evolv-models.mjs";

export const INSTALL_PHASES = ["idle", "checking", "pulling", "creating", "ready", "error"];

// Ollama reports a pull as a set of layers, each with its own byte counts, and
// re-reports the same layer as it advances. Summing the latest figure per layer
// gives a real total for the whole download — no invented percentages, and no
// bar that goes backwards when a new layer starts.
export function createPullProgress() {
  const layers = new Map();
  return function apply(event = {}) {
    const digest = event.digest || event.status;
    const total = Number(event.total) || 0;
    if (digest && total > 0) {
      layers.set(digest, { completed: Math.min(Number(event.completed) || 0, total), total });
    }
    let completed = 0;
    let overall = 0;
    for (const layer of layers.values()) {
      completed += layer.completed;
      overall += layer.total;
    }
    return {
      status: String(event.status || ""),
      completed,
      total: overall,
      // Null rather than zero while Ollama is still resolving the manifest: the
      // interface shows a phase for an unknown size and a bar for a known one.
      percent: overall > 0 ? Math.min(100, Math.floor((completed / overall) * 100)) : null
    };
  };
}

function friendlyFailure(error) {
  if (error?.code === "OLLAMA_UNREACHABLE") {
    return { message: "Ollama stopped responding. Start Ollama and try again.", code: error.code };
  }
  if (/no space left|disk|storage/i.test(error?.message || "")) {
    return { message: "There is not enough disk space to install Evolv Local.", code: "OUT_OF_SPACE" };
  }
  return { message: "Evolv Local couldn't finish downloading.", code: error?.code || "INSTALL_FAILED" };
}

export function createEvolvLocalService({ client, clock = () => Date.now(), log = () => {} } = {}) {
  let run = null;

  function snapshotOf(state) {
    return state ? { ...state } : { phase: "idle", model: null, percent: null, completed: 0, total: 0, status: "" };
  }

  async function status() {
    let models = [];
    let version = "";
    let reachable = true;
    try {
      version = await client.version();
      models = await client.listModels();
    } catch (error) {
      reachable = false;
      log("evolv-local.unreachable", { error: error.message });
    }

    const names = models.map((model) => model.name);
    const definition = evolvModelDefinition(DEFAULT_EVOLV_MODEL);
    // Ollama answers "llama3.2:3b" for a model pulled as "llama3.2:3b", but a
    // model pulled without a tag comes back tagged "latest". Both spellings of
    // the same model have to count as present.
    const has = (name) => names.some((item) => item === name || item.replace(/:latest$/, "") === name.replace(/:latest$/, ""));

    return {
      ollamaReachable: reachable,
      version,
      models: names,
      modelCount: names.length,
      evolvModel: definition.name,
      evolvModelLabel: definition.label,
      evolvModelInstalled: reachable && has(definition.name),
      // Lets the interface offer "finish setting up" instead of a fresh
      // multi-gigabyte download after a failure between the two steps.
      baseModel: definition.base,
      baseModelInstalled: reachable && has(definition.base),
      approximateBytes: definition.approximateBytes || 0,
      install: snapshotOf(run?.state)
    };
  }

  function publish(state, patch) {
    Object.assign(state, patch, { updatedAt: clock() });
    for (const listener of state.listeners) listener({ ...state, listeners: undefined });
  }

  function begin(modelName) {
    const definition = evolvModelDefinition(modelName);
    const controller = new AbortController();
    const state = {
      phase: "checking",
      model: definition.name,
      base: definition.base,
      status: "Checking what is already installed…",
      completed: 0,
      total: 0,
      percent: null,
      error: null,
      cancelled: false,
      startedAt: clock(),
      updatedAt: clock(),
      listeners: new Set()
    };

    // Cancelling lands between steps as often as during one, and a step that
    // has already been asked to stop must not start the next.
    const ensureLive = () => {
      if (controller.signal.aborted) throw Object.assign(new Error("Installation cancelled."), { name: "AbortError" });
    };

    const done = (async () => {
      try {
        const installed = (await client.listModels()).map((model) => model.name);
        ensureLive();
        const alreadyHasBase = installed.some((name) => name === definition.base);

        if (alreadyHasBase) {
          // The expensive half is already done — say so, because "skipping a
          // 2GB download" is the difference between a retry that takes seconds
          // and one the user abandons.
          publish(state, { phase: "pulling", status: "Base model already downloaded.", percent: 100 });
        } else {
          const apply = createPullProgress();
          publish(state, { phase: "pulling", status: "pulling manifest", percent: null });
          await client.pull(definition.base, {
            signal: controller.signal,
            onEvent: (event) => publish(state, apply(event))
          });
        }

        ensureLive();
        publish(state, { phase: "creating", status: "Configuring Evolv Local…", percent: null });
        await client.create(definition.name, definition, {
          signal: controller.signal,
          onEvent: (event) => publish(state, { status: String(event.status || state.status) })
        });

        // Trust Ollama's list rather than the absence of an error: a create that
        // reported success but produced nothing must not be announced as ready.
        const after = (await client.listModels()).map((model) => model.name);
        if (!after.includes(definition.name)) {
          throw Object.assign(new Error(`Ollama did not report ${definition.name} after creating it.`), { code: "MODEL_MISSING_AFTER_CREATE" });
        }

        publish(state, { phase: "ready", status: `${definition.label} is ready.`, percent: 100, error: null });
        log("evolv-local.installed", { model: definition.name, base: definition.base });
      } catch (error) {
        if (controller.signal.aborted) {
          publish(state, { phase: "idle", status: "Installation cancelled.", cancelled: true, percent: null });
          return;
        }
        const friendly = friendlyFailure(error);
        publish(state, {
          phase: "error",
          status: friendly.message,
          // The underlying text is kept separate so the interface can hide it
          // behind a details toggle instead of showing a stack to everyone.
          error: { ...friendly, detail: String(error?.message || error) }
        });
        log("evolv-local.failed", { model: definition.name, error: String(error?.message || error) });
      } finally {
        state.finished = true;
      }
    })();

    return { state, controller, done, model: definition.name };
  }

  return {
    status,

    state() {
      return snapshotOf(run?.state);
    },

    // Returns the live run whether it was started by this call or an earlier
    // one. A second click, or a reopened window, joins the run in flight; only
    // a request for a different model is refused.
    install({ model = DEFAULT_EVOLV_MODEL } = {}) {
      if (!isEvolvModel(model)) evolvModelDefinition(model); // throws a 404 naming the known models
      if (run && !run.state.finished) {
        if (run.model !== model) {
          throw Object.assign(new Error(`${run.model} is already being installed. Wait for it to finish.`), {
            status: 409, code: "INSTALL_IN_PROGRESS", expose: true
          });
        }
        return handle(run);
      }
      run = begin(model);
      return handle(run);
    },

    cancel() {
      if (!run || run.state.finished) return false;
      run.controller.abort();
      return true;
    }
  };

  function handle(current) {
    return {
      model: current.model,
      done: current.done,
      snapshot: () => ({ ...current.state, listeners: undefined }),
      subscribe(listener) {
        // The current state first, so a client that arrives mid-download sees
        // where things stand instead of waiting for the next byte.
        listener({ ...current.state, listeners: undefined });
        if (current.state.finished) return () => {};
        current.state.listeners.add(listener);
        return () => current.state.listeners.delete(listener);
      }
    };
  }
}
