# Evolv Local (`evolv:latest`)

Evolv Local is the model Evolv installs for you. It is **not a trained model**
— it is a small open base model with Evolv's system prompt and generation
settings baked in, built on your machine by Ollama. Saying anything stronger
than that would be a lie, and this document is where that distinction is kept
honest.

Its reason to exist is the first run. Ollama can be installed, running, and
answering every request while holding no models at all. Evolv used to show that
state as a green "Ollama connected" dot and then fail on the first message.

## The pieces

| Concern | File |
| --- | --- |
| What a variant is: base, prompt, parameters | `lib/evolv-models.mjs` |
| Talking to Ollama about models | `lib/ollama-client.mjs` |
| Installing one, with state and progress | `lib/evolv-local.mjs` |
| HTTP surface | `server.mjs` (`/api/health`, `/api/ollama/*`) |
| Status, install button, progress | `public/app.js`, `public/index.html` |

The order is deliberate: the client knows nothing about Evolv's models, the
installer knows nothing about HTTP, and the routes know nothing about pulling.

## The system prompt

`EVOLV_SYSTEM_PROMPT` at the top of `lib/evolv-models.mjs`, as one readable
block of prose. Edit it there and nowhere else. It is what tells the local model
it is running inside Evolv, that it should make assumptions explicit, separate
facts from estimates, use only tools it was actually offered, and never claim it
performed an action Evolv has not confirmed.

Two constraints, both held by tests:

- It must not contain `"""`, which would close the `SYSTEM` block early and
  silently truncate the model's personality.
- Changing it does not change an already-installed `evolv:latest`. Ollama built
  that model from the prompt as it read at install time; a new prompt reaches a
  user only when the model is created again.

## The base model

`llama3.2:3b`, set in one place — the `base` field of the `evolv:latest` entry —
and overridable at runtime:

```sh
EVOLV_LOCAL_BASE_MODEL=qwen2.5:3b npm start
```

Change the field to change it for everyone; use the variable to try one without
shipping a build.

## Installation flow

```
POST /api/ollama/install-evolv
  │
  ├─ checking   ask Ollama what is already installed
  ├─ pulling    POST /api/pull   (skipped entirely if the base is present)
  ├─ creating   POST /api/create (system prompt + parameters)
  ├─ verify     GET  /api/tags   — the model must actually be listed
  └─ ready
```

The response is NDJSON, one state object per line, the same streaming shape chat
uses. Every line carries `phase`, `status`, `completed`, `total` and `percent`.

**Progress is real.** Ollama reports a pull layer by layer, each with its own
byte counts, and re-reports a layer as it advances. `createPullProgress` keeps
the latest figure per layer and sums them, so the bar tracks bytes rather than
time and cannot run backwards. Before any byte counts arrive, `percent` is
`null` and the interface sweeps an indeterminate bar rather than inventing a
number.

**One install at a time.** The run lives in the server. A second click, or a
window closed and reopened mid-download, subscribes to the run already in
flight and is handed the current state immediately. Only a request for a
*different* Evolv model is refused, with 409.

**A failed create never re-downloads the base.** The base model is several
gigabytes and the two steps fail independently, so a retry after a failed
create skips straight to `creating` and says so.

### Ollama endpoints used

| Endpoint | Used for |
| --- | --- |
| `GET /api/version` | Is Ollama reachable |
| `GET /api/tags` | What is installed — the answer to "is this a ready install" |
| `POST /api/pull` | Downloading the base model (streaming) |
| `POST /api/create` | Building `evolv:latest` (streaming) |

`/api/create` changed shape across Ollama versions: newer builds take `from`,
`system` and `parameters` as separate fields, older ones only understand a
`modelfile` string. The client sends the structured form and falls back to a
Modelfile if it is rejected, so Evolv builds a model either side of that change.

## The four states

| State | Dot | What the user sees |
| --- | --- | --- |
| Ollama unreachable | red | "Ollama isn't running." |
| Reachable, no models | amber | "Ollama is running, but no AI models are installed." + **Get Evolv Local** |
| Models, but no `evolv:latest` | green | Their models work; a quiet offer to install Evolv Local |
| `evolv:latest` present | green | "Evolv Local ready" |

The third state never blocks anything. A model someone pulled themselves is a
working install, and Evolv has no business talking them out of it.

`/api/health` keeps `connected` with its original meaning so existing readers
are unaffected, and adds `ollamaReachable`, `modelCount`, `models`,
`evolvModelInstalled`, `baseModelInstalled` and the live `install` state.

## Adding a variant

Add an entry to `ENTRIES` in `lib/evolv-models.mjs`:

```js
"evolv:engineer": {
  name: "evolv:engineer",
  label: "Evolv Engineer",
  base: "qwen2.5-coder:7b",
  system: ENGINEER_SYSTEM_PROMPT,
  parameters: { temperature: 0.4, num_ctx: 16384 }
}
```

Nothing else changes. `POST /api/ollama/install-evolv` takes a `model` field, the
installer looks it up, and an unknown name is refused with a 404 that lists the
ones that exist.

## Replacing this with a real fine-tune

When there is an actual trained Evolv model, the shape barely moves. Give the
entry a `source` other than a base model — a GGUF path or a published Ollama
name — and change `createOllamaClient.create` to pass that instead of `from`.
The states, the progress accounting, the single-flight run, the routes and the
interface do not know the difference between building a model and downloading
one, and none of them need to.

## Tests

`test/evolv-local.test.mjs` covers the states, the progress parser, the install
flow, cancellation, the retry that skips the download, and the create fallback,
all against a fake client. `test/evolv-local-server.test.mjs` runs the whole
flow against a real server and a mock Ollama that starts with no models: health
reports not-ready, the install streams real percentages, `evolv:latest` appears
in the model list, and a restart recognises it. Neither downloads anything.
