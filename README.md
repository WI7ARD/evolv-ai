# Evolv

Stage 5 evidence-based evolution details: [docs/STAGE-5-EVIDENCE-EVOLUTION.md](docs/STAGE-5-EVIDENCE-EVOLUTION.md)

Stage 6 local hearing intelligence details: [docs/STAGE-6-HEARING-INTELLIGENCE.md](docs/STAGE-6-HEARING-INTELLIGENCE.md)

Stage 7 reliability and release details: [docs/STAGE-7-RELIABILITY-RELEASE.md](docs/STAGE-7-RELIABILITY-RELEASE.md)

Evolv is a local-first chat that runs against local Ollama models, with OpenAI
available for when a local model is not enough. It has model switching,
reasoning controls, safe local tools, persistent SQLite conversations, feedback,
reversible behavioral upgrades, and two sandboxes — physics and circuits — that
the assistant can build in and read the results of. It runs in the browser
(`npm start`) or as a hardened Windows desktop app.

## Private adaptive profile

Evolv can propose communication, learning, explanation, pace, workflow, and feedback preferences from conversations. Nothing becomes active until the signed-in user approves it. Approved preferences are scoped to that local profile, used as defaults when relevant, and overridden by the current request. Evolv does not intentionally infer sensitive identity, health, demographic, political, religious, or personality traits.

It also includes:

- Multiple local accounts, each with its own password, recovery code, and fully isolated conversation database
- Cloud provider support with encrypted, write-only API-key storage
- Persistent conversations with search, rename, archive, trash, and restore
- Balanced Auto model routing across enabled local and cloud models, with visible reasons, per-model scoring, cloud opt-in, and a monthly cost-unit safeguard
- Rich chat rendering (links, lists, tables, blockquotes, code blocks with one-click copy), response regeneration and retry, and editable ratings
- A bounded tool catalog with audited local/network reads plus approval-gated Obsidian note proposals
- A persistent project memory graph — approved projects, tasks, decisions, and preferences are linked together and retrieved into every chat; model-extracted memories stay proposed until you approve them
- Continual post-turn memory inspection with an editable Memory Inbox for create, update, merge, and retire proposals
- Feedback-derived evaluation cases and blind active-vs-proposed prompt comparisons before behavioral upgrades are activated
- Composite tool suggestions and AI-assisted generated recipes that combine only approved built-ins; every vault write still requires its own visible diff approval
- A desktop-only, profile-isolated connection to a dedicated Obsidian vault with live indexing, citations, backlinks, and local-first cloud privacy controls
- Image attachments for vision-capable models
- Backup, portable export, and non-destructive import — from the settings dialog or the API
- Optional automatic spoken replies and per-message text-to-speech
- Local camera gesture recognition powered by Google MediaPipe
- User-approved semantic knowledge retrieval through Ollama embeddings
- Collaborate, Cognitive, and creative Muse response modes
- Review-only architecture evolution proposals with risks and acceptance tests

It does **not** silently rewrite its own code or grant itself new permissions. Instead, it uses a transparent improvement loop:

1. Chat with any installed Ollama model.
2. Rate responses and optionally explain what went wrong.
3. Ask a selected model to propose an improved system prompt.
4. Review the rationale, full prompt, and acceptance tests.
5. Approve the version or discard it. Restore any earlier version later.

## Personal intelligence

Choose **Auto · Balanced** in the model selector to let Evolv select from eligible models. Simple requests prefer local Ollama models; configured cloud providers are excluded until you explicitly enable each one under **Intelligence**. Every routed response shows the chosen provider, model, local/cloud status, and selection reasons. Manual model selection always remains available.

If an Auto-eligible provider cannot be checked, Evolv clearly labels the route
**FALLBACK USED**, names the unavailable provider, and shows the model it continued
with. Manual model selections never switch silently: they either use the chosen
model or display the provider error.

The **Intelligence** workspace contains:

- Auto controls and per-model quality, speed, cost, privacy, and eligibility scores
- Separate provider opt-ins for Auto routing and for sending Obsidian excerpts to cloud models; vault sharing starts off for every cloud provider
- A cloud cost-unit safeguard (`0` means unlimited) and an evaluation-case limit of up to ten
- A Memory Inbox where post-turn proposals can be edited, approved, rejected, or approved in a selected batch
- Routing history, feedback-derived route ratings, blind evaluation results, and reviewable routing-weight proposals

Ratings create reusable evaluation cases. A proposed system prompt can be compared blindly against the active prompt on those cases; the result reports quality, instruction following, factuality, memory use, tool use, wins, losses, ties, and critical regressions. An evaluation recommendation is evidence for your decision, never an automatic activation.

## Run

Requirements:

- Node.js 20.3 or newer
- [Ollama](https://ollama.com/) running locally
- At least one installed model, such as `qwen3` or `llama3.2`

```powershell
ollama pull qwen3
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

On Windows, you can also double-click `start.cmd`.

## Desktop updates and GitHub releases

Evolv 0.6.3 is the first updater-capable Windows build. In the packaged app,
open **Settings â†’ Software updates**. Evolv checks the stable release from
`WI7ARD/evolv-ai`, requires an exact release ZIP and `.sha256` file,
verifies the packaged executable and application archive, then replaces the
portable app folder and restarts. It never installs drafts or prereleases and
never downloads an update silently.

On Linux, the AppImage updates itself in place and downloads only the parts
that changed. Most of the image is Electron, which is identical between
releases, so an update is normally a few megabytes rather than three hundred:
Evolv fetches a block map published beside the AppImage, finds those blocks in
the copy already installed, and asks the server only for the rest. The
assembled file must match the release's published SHA-256 before anything is
replaced, and the previous AppImage is kept beside the new one until Evolv has
started successfully once. Updates are offered only when Evolv is running as an
AppImage; a copy installed by a package manager or run from source owns its own
updates.

The repository checked for updates is read from `package.json`, so it cannot
drift from the one the release workflow publishes to. Set
`EVOLV_UPDATE_REPOSITORY` to override it. See
[docs/GITHUB-RELEASES.md](docs/GITHUB-RELEASES.md) for the release procedure.
Version 0.6.3 must be installed manually once; subsequent stable releases can
be installed inside Evolv.

The first page creates Evolv's local password and a one-time recovery code.
Store that recovery code somewhere private: Evolv keeps only its hash and
cannot display it again. Sessions lock after 30 minutes without activity,
after 12 hours total, or whenever the server restarts.

## Accounts and profiles

Evolv supports up to 25 local accounts on one installation. Each account has its
own username, salted-`scrypt` password, and one-time recovery code, and each
gets a completely isolated SQLite database under `data/profiles/<id>/` — one
account can never see another's conversations, settings, knowledge, or API keys.

If you are upgrading from a single-user Evolv, the existing login and its chat
history migrate automatically into an `owner` account on first launch, and the
original database is backed up untouched under `data/backups/` first.

## Cloud AI providers

Beyond local Ollama, Evolv can talk to hosted models. Open **Settings → API** and
add a key for any of:

| Provider | Notes |
| --- | --- |
| Ollama | Local, no key required (default `http://127.0.0.1:11434`) |
| OpenAI | Chat models via the Responses API, with native tool calling |

Two, deliberately. Evolv used to speak six, and roughly two thirds of the
provider layer was the seam between their dialects — each one a place to be
subtly wrong in a way only that provider would notice. Adding a third is a
decision to be made again, not a table to append to.

API keys are encrypted before they touch disk and are **write-only** — Evolv
never returns a stored key to the browser or includes one in an export. On the
desktop app, keys are sealed with the Windows Data Protection API (DPAPI) so
they can only be decrypted by the same Windows user on the same machine; in the
browser build they are encrypted with a key held in the server's data directory.
Outbound provider requests refuse redirects, so a key cannot be forwarded to
whichever host a redirect names.

Capabilities (tools, vision, thinking) are detected per model and shown as
badges in the picker, exactly as for local models. All providers stream
token-by-token, a stray malformed stream line is skipped instead of aborting
the reply, and the **Max reply tokens** setting (Settings → Generation)
controls the output ceiling for cloud models (default 4K).

## Local security

The main page, application assets, gesture model, exports, and every AI/data
API require an authenticated session. Passwords use salted `scrypt` hashes;
session cookies are host-only, `HttpOnly`, and `SameSite=Strict`. Mutating
requests also require a per-session CSRF token, and the server rejects
unexpected Host, Origin, and cross-site request metadata.

Evolv remains bound to `127.0.0.1` and is not designed for LAN or internet
exposure. The SQLite database and backups are not encrypted, so Windows account
security and full-disk encryption remain responsible for data at rest. Ollama's
separate port is also outside Evolv's password gate.

## Model support

Evolv adapts to each model's capabilities, shown as badges in the model picker:

| Capability | Badge | Behavior |
| --- | --- | --- |
| Tools | 🔧 | The model may call Evolv's read-only local tools; activity appears as cards in chat and in the Tools view audit log. |
| Vision | 👁 | An attach button appears in the composer; up to three images per message. |
| Thinking | 🧠 | The reasoning control offers Off/On (or Low/Medium/High for GPT-OSS-style models). |

Models without a capability degrade gracefully: tool-less models answer directly (with a notice if tools are enabled), and embedding-only models are kept out of the picker. If a thinking-capable model leaks chain-of-thought into its answer, Evolv reroutes it into the collapsible reasoning trace instead of showing it as content.

## Safe local tools

Tools are read-only, time-limited, output-capped, and audited. Workspace tools
are sandboxed to the project with traversal, symlink, and secret-file
protection. Four optional no-key network tools use fixed HTTPS destinations only:

- `get_weather` — current conditions and a 1–7 day forecast from Open-Meteo
- `get_kanye_quote` — a random short quote from kanye.rest
- `convert_currency` — current reference exchange rates from Frankfurter
- `search_wikipedia` — bounded English Wikipedia article search

These tools cannot accept arbitrary URLs, follow redirects, submit data, or
write files. Their responses are treated as untrusted reference data. Use the
Tools view to toggle individual tools or disable them all; duplicate calls
within a single response reuse the cached result instead of re-executing.

### Composite tools and generated recipes

Evolv watches its own tool audit log for pipelines you use repeatedly — for example a workspace search followed by reading the found file. When the same sequence recurs across conversations, the Tools view shows it under **Suggested pipelines**. Suggestions never activate themselves: you review an editable JSON definition — steps, argument templates like `{{input.query}}` and `{{steps.0.output.0.path}}`, and named inputs — and approve it into a `macro_*` tool.

The **Generate tool** panel can ask a selected model to draft the same declarative format. Generated recipes are limited to eight sequential calls to currently enabled built-ins. Validation rejects JavaScript, shell commands, packages, arbitrary URLs, secrets, loops, direct private paths, macro nesting, and permission expansion. Generation and dry-run do not install anything. Installation needs explicit approval, every approved version is hashed and reversible, and a write-capable step pauses the recipe until its individual Obsidian diff is approved or rejected.

### Private Obsidian memory

In Evolv.exe, open **Mind → Obsidian Memory** and choose a dedicated vault. The Electron main process owns the real folder path; the browser UI receives only a short-lived opaque grant, the vault label, and vault-relative note information. One canonical vault can belong to only one Evolv profile.

Markdown and Canvas files are reconciled at startup, watched live, and checked periodically. Evolv indexes headings, tags, aliases, wikilinks, backlinks, Canvas nodes/edges, and stable `evolv_id` values. `.obsidian`, hidden/trash folders, symlinks, binaries, generated tool specifications, and oversized files are excluded from retrieval. Local embeddings are used when the Ollama embedding model is available; otherwise search remains lexical.

Direct edits made in Obsidian are treated as your edits. AI-created changes are different: they appear as full before/after diff cards and never reach disk before approval. Create, edit, move, and archive are supported; permanent deletion is not. Approved changes have a guarded one-click undo, and conflicts are stopped when the note changed after the diff was created.

When connected, the vault is the authoritative memory source. Existing Evolv memory is copied non-destructively only after note counts, IDs, links, and hashes verify, and the SQLite records remain intact. Portable exports omit the vault connection, path, and authoritative note contents. Cloud providers receive no vault excerpts or vault-backed tools until that provider is explicitly enabled under **Intelligence**.

## Project memory

The Mind Studio's **Project memory** panel holds a small graph of typed records — projects, tasks, decisions, preferences, and notes — that persist across conversations and accounts' isolated databases. Active project and task records are always in context (your current focus), and other records are retrieved semantically per message, exactly like knowledge. Records can be linked to each other, and the model sees those links.

For plain `npm start`, memory remains manually Obsidian-compatible without granting external-folder access. Writing `[[Title]]` inside a record's text creates graph links. **Export Obsidian vault** writes Markdown notes into the profile data folder, and **Import vault…** reads selected `.md` notes back non-destructively. Use Evolv.exe for the dedicated live vault described above.

Memory comes from two places: you can add records directly, or press **Extract memory from current conversation** to have a model of your choice propose records from the transcript. Extracted records are saved with a `proposed` status and are not used for retrieval until you approve them; you can also resolve tasks, archive stale records, or reactivate them later. A read-only `search_memory` tool lets the model consult the graph mid-chat, and retrieved memories are shown as a badge on each reply.

## Conversations and data

All chat history, settings, feedback, prompt versions, knowledge, and tool runs are stored server-side in SQLite (`data/evolv.db`, WAL mode). Legacy `data/state.json` files and browser localStorage history are migrated automatically on first run, with the originals backed up untouched.

From the settings dialog (gear icon):

- **Create backup** — snapshot the database into `data/backups/` (a daily backup also runs automatically; the ten most recent are kept)
- **Export everything** — download a portable JSON file of conversations, versions, feedback, and knowledge (embeddings excluded)
- **Import** — preview a previously exported file, then merge it without deleting existing data

## Local voice and gesture controls

Use the buttons beside the message box:

- Dot/microphone: start or stop live local listening
- Speaker: automatically read new assistant replies with Piper (or the Windows fallback voice)
- Hand: open camera gesture controls

In the Windows desktop app, the round microphone button is push-to-talk. Hold
the button while speaking and release it to stop the microphone. Evolv converts
that short recording to a 16 kHz WAV, transcribes it with the bundled
Whisper.cpp `base.en` model, deletes the temporary file, and sends the resulting
text. There is no wake word and no background listening. Raw audio is not saved
in SQLite or sent to an AI provider; recognition never falls back to a cloud
speech service.

To diagnose push-to-talk, expand **Voice diagnostics** in Settings. It reports
whether the microphone is recording, whether local transcription is running,
the last transcript, and the latest error.

For Piper text-to-speech, open Settings and use **Download more voices**, then
select the `piper.exe` Windows runtime or extensionless `piper` Linux runtime
plus a voice `.onnx` file. The matching `.onnx.json` configuration must sit
beside the model. Evolv auto-detects complete Piper files in Downloads, gives
Piper only the bounded reply text, deletes its temporary WAV after playback,
and falls back to a voice installed on the device when Piper is incomplete. The downloaded
`en_GB-northern_english_male-medium.onnx` model still needs its matching JSON
configuration and a Piper runtime before Piper can run.

Push-to-talk Whisper recognition and Piper are desktop-only. `npm start` keeps
browser speech output as a fallback but does not expose native executables or
microphone transcription to the web page.

Gesture mappings:

- Thumb up: send the current draft
- Point up: focus the message box
- Victory: read the latest reply
- Closed fist: stop generation and speech

The MediaPipe runtime and gesture model are bundled with the app. Camera frames
are processed inside the browser and are not uploaded to the Node server.

## Knowledge and cognitive modes

The Mind Studio lets you add knowledge under General, Project, NLP, Computer
Vision, Machine Learning, Deep Learning, Creative, and preference domains.
Evolv embeds approved records with `nomic-embed-text:latest` and retrieves the
most relevant records for each chat request. If that embedding model is not
available, it falls back to keyword retrieval.

Mind modes:

- Collaborate: normal assistant behavior
- Cognitive: perceive, retrieve, plan, verify, and respond
- Muse: higher-variance creative synthesis with a randomized generation seed

Selecting a mode first opens an explanation of its best uses, behavioral
changes, and tradeoffs. The mode is activated only after confirmation.

The cognitive cycle is a response architecture, not a claim that the model is
conscious or thinks like a human.

## Safe code evolution

The Architecture Proposals panel converts requirements and feedback into
reviewable component changes, risks, and tests. These proposals cannot edit
files, execute code, expand permissions, or apply themselves. Actual code
changes remain a separate human-approved development step.

## Sandbox — try the change before making it

Evolv can do the work in a private copy of your project before touching a
single real file. It mirrors the project's text files into a sandbox, edits
there, runs syntax checks and approved package scripts there, and leaves your
project untouched. A simulation that fails is thrown away and costs you
nothing.

Only one thing can write to your project: approving the promotion, which
arrives as an ordinary diff approval in chat. Before writing, Evolv re-checks
every target file and refuses the whole set if anything changed while the
simulation ran — approved work is never applied on top of an edit you made in
the meantime, and a multi-file change is all-or-nothing.

Trying a change is automatic; applying it is not. That split is deliberate:
the model should be free to attempt, fail, and retry without interrupting you,
so the one approval you see is a result that already passed its checks.

Secrets never enter a sandbox. `.env` files, credentials, keys, hidden folders
and `node_modules` are excluded by the same rules that protect the project
tools.

Type `/sandbox` in chat to review open simulations, run their checks, or
discard them. While any simulation is open, Evolv says so — the project on
disk is unchanged until you say otherwise.

## Verified goal runner

Type `/agent` in the chat box to plan and run a bounded goal; `/agent <goal>`
drafts the objective in one step. The command is handled in the browser and is
never sent to a model.

You state the outcome and its success criteria, and a model of your choice
proposes a structured plan. Nothing runs until you have read that plan and
approved it — and you can edit it first. Safe local reads then proceed on their
own, while network research, file changes, engineering checks, and Obsidian
note changes each stop for their own approval. A run completes only when a
final verification step records evidence for the original criteria; a model
answer without evidence is reported as partial or failed, never as success.

Runs are durable: they survive a restart, can be paused, resumed, replanned,
or cancelled, and each keeps its own step history, evidence, and budget.

## Evolv Marketplace

Marketplace turns Evolv into a modular, local-first capability platform. The
bundled offline catalog includes Arduino Debugger, Linux Repair Agent,
Repository Auditor, UI Critic, Local AI Setup Assistant, Motorcycle
Maintenance Assistant, Small Business Knowledge Assistant, and Game
Development Assistant.

Packs are declarative: they may register specialist agents, prompt commands,
workflows, knowledge, documentation, and validated configuration, but cannot
execute JavaScript, shell commands, packages, or installation hooks. Every
permission is shown before installation; update permissions require fresh
approval. Installed state and encrypted pack secrets are isolated per profile.

Open **Marketplace** in the sidebar to browse, search, install, configure,
disable, update, export, or uninstall packs. Developer Mode validates local
`.evolvpack` files and generates complete starter packs.

- [Marketplace architecture](docs/MARKETPLACE.md)
- [Pack format and manifest](docs/PACK_FORMAT.md)
- [Pack development tutorial](docs/PACK_DEVELOPMENT.md)

## Configuration

```powershell
$env:PORT = "3000"                          # HTTP port (default 3000)
$env:OLLAMA_URL = "http://127.0.0.1:11434"  # Ollama endpoint
$env:EVOLV_DB_PATH = "D:\evolv\evolv.db"    # Override the SQLite database path
$env:EVOLV_DATA_DIR = "D:\evolv"            # Override the data directory (backups, legacy import)
$env:OLLAMA_STREAM_IDLE_MS = "120000"       # Stream stall watchdog (default 120s)
npm start
```

If Ollama stops sending data mid-response for longer than the watchdog window,
Evolv cancels the request, records the message as an error, and tells you —
instead of hanging.

## Reasoning modes

Ollama's `think` option is passed through:

- `Off` / `On` for models that support boolean thinking
- `Low` / `Medium` / `High` for models such as GPT-OSS

Models without thinking support show a disabled `Not supported` control.

## Desktop app (Windows and Linux Mint)

Evolv ships as a hardened Electron desktop app. The main process binds the
server to a random loopback port, disables Node integration, enables context
isolation and the sandbox, denies pop-ups and off-origin navigation, and only
grants camera access to its own origin.

```powershell
npm run desktop     # run the desktop app in development
npm run dist:win    # build the distributable Windows ZIP in out/make/
```

You do not have to build it yourself to try a change. Every push and pull
request runs a **Windows package** job that produces the same ZIP and attaches
it to the run: open the commit or pull request on GitHub, follow its checks to
the Actions run, and download the `Evolv-Windows-x64` artifact (the ZIP plus its
`.sha256`). Artifacts are kept for 14 days. Tagged releases, which is what the
in-app updater consults, are published separately by the Windows release
workflow — see [docs/GITHUB-RELEASES.md](docs/GITHUB-RELEASES.md).

`dist:win` produces `out/make/zip/win32/x64/Evolv-win32-x64-<version>.zip`,
bundling Electron, the app in an `asar`, the native `better-sqlite3` binary
(kept unpacked so it can load at runtime), the generated application icon, and
`.itch.toml`.

On a 64-bit Linux Mint computer:

```bash
sudo apt install libsecret-1-0
npm install
npm test
npm run dist:linux
```

`dist:linux` produces a portable `out/Evolv-linux-x64` folder and
`out/make/tar/linux/x64/Evolv-linux-x64-<version>.tar.gz`. It injects the
Linux Electron-ABI SQLite module, preserves the launcher's executable bit,
uses a Linux itch manifest, and validates that Windows-only voice binaries did
not enter the package. For setup, local voice, secure keyring, and itch.io
instructions, see [LINUX-MINT.md](LINUX-MINT.md).

### Toolchain notes

The build is pinned to **Electron 41.10.4**, the newest supported Electron line
with a verified `better-sqlite3` Windows prebuild for this release. Electron 42
does not have a compatible prebuild, so moving beyond 41 currently requires a
C++ toolchain or a database-runtime change. `dist:win` fetches the matching
native binary, so no compiler is needed. Stay on the newest 41.x patch: patch
releases share the 41 ABI, so the same prebuild applies, and 41.10.3 fixed a
sandboxed-iframe popup bypass (GHSA-9f4c-93c8-jc8g).

`dist:win` is used instead of `electron-forge make` because, on Node 24+,
`extract-zip` (via `yauzl`/`fd-slicer`) hangs while unpacking the Electron
template and `@electron/rebuild` insists on compiling native modules from
source. A `postinstall` step (`scripts/patch-extract-zip.mjs`) works around the
first issue by extracting with the bundled Windows `bsdtar`; `dist:win` works
around the second by injecting the prebuilt `better-sqlite3` binary directly.

The application icon is generated (no image tools required):

```powershell
node scripts/make-icon.mjs   # regenerate build/icon.ico
```

## Publishing to itch.io

Releases are pushed to itch.io with [Butler](https://itch.io/docs/butler/).
Each package receives a platform-specific `.itch.toml`: `Evolv.exe` for
Windows and `Evolv` for Linux. Butler validates and pushes the unpacked
platform folder, not its ZIP or tarball.

```powershell
$env:BUTLER_API_KEY = "your butler key"   # or run: butler login
npm run dist:win        # build the package first
npm run itch:validate   # validate the packaged app and .itch.toml
$env:ITCH_USER = "your-itch-username"
$env:ITCH_PROJECT = "evolv"              # your itch.io project slug
npm run itch:push        # push to <user>/<project>:windows via Butler
Remove-Item Env:BUTLER_API_KEY, Env:ITCH_USER, Env:ITCH_PROJECT
```

The matching Linux commands are `npm run itch:validate:linux` and
`npm run itch:push:linux`; they publish `out/Evolv-linux-x64` to the `linux`
channel.

### Windows Authenticode release gate

Evolv never reports an unsigned executable as signed. Signing requires a real
code-signing certificate in the Windows certificate store, the Windows SDK
`signtool.exe`, and an RFC 3161 timestamp service:

```powershell
$env:WINDOWS_SIGN_CERT_SHA1 = "40_CHARACTER_CERTIFICATE_THUMBPRINT"
$env:WINDOWS_TIMESTAMP_URL = "https://your-ca.example/rfc3161"
npm run sign:status:win

# Sign automatically during dist:win, then verify every Evolv-controlled native file.
$env:EVOLV_SIGN_WINDOWS = "1"
$env:EVOLV_REQUIRE_CODE_SIGNING = "1"
npm run dist:win
npm run release:gate:win
```

The signer covers `Evolv.exe` and unpacked native `.node` modules with SHA-256,
then independently checks their Authenticode status and expected certificate
thumbprint. `dist:win` writes `release-integrity.json` with the honest result.
The itch.io push command blocks an unsigned Windows build by default. For a
deliberate unsigned private/test release only, set
`EVOLV_ALLOW_UNSIGNED_PUSH=1`; the command prints an explicit warning and
Windows SmartScreen may warn users.

## Test

```powershell
npm test
```

The suite runs fully offline — streamed chat, tool loops, stall/interrupt
handling, and vision gating are exercised against a built-in mock Ollama
server (`test/helpers/mock-ollama.mjs`).

With the app and Ollama running, verify real streamed responses:

```powershell
$env:EVOLV_PASSWORD = "your Evolv password"
npm run smoke            # plain streamed chat round-trip
npm run smoke:persisted  # persisted chat with a forced tool call
npm run smoke:models     # every installed model, pass/fail table
Remove-Item Env:EVOLV_PASSWORD
```
