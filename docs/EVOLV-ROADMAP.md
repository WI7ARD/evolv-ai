# Evolv — Architecture and Roadmap

Written against the code as it stands at `0.6.3`, not a blank page. Evolv is
roughly 30,000 lines of working software, and a large part of what the brief
asks for in Phase 1 is already built. The useful version of this document is
therefore not a greenfield design; it is an honest inventory, a set of gaps,
and an argued opinion about three decisions in the brief that would damage the
product if taken literally.

---

## 0. Where Evolv actually is

The brief's core philosophy — trust, recoverability, transparency, user
control — is already the codebase's organising principle. What is missing is
narrower and more specific than "build the safest AI workspace possible".

| Phase 1 requirement | Status | Evidence |
| --- | --- | --- |
| Atomic writes | **Done** | `engineering-actions.mjs`: temp file with `wx`, then `rename` |
| Diff viewer before applying | **Done** | Every write is a staged proposal with before/after hashes and line counts |
| Transaction-based file operations | **Done** | Nothing reaches disk before an approval decision |
| Risk-tiered approval | **Done, and finer than asked** | Six tiers, not three (below) |
| Tool retries / timeouts / typed errors / logging / validation | **Done** | `tool-contracts.mjs`: `createToolSignal`, cooperative abort, dry-run policy, typed codes; every call rows into `tool_runs` |
| Complete audit log | **Done** | `audit_events`, `tool_runs`, `run_events` (ordered `sequence`), `run_checkpoints` |
| Crash recovery | **Done** | Startup reconciliation closes interrupted messages, runs, leases |
| Memory system / Obsidian | **Done** | Live-indexed vault, embeddings + lexical fallback, BYO vault, one vault per profile |
| Secret protection | **Done** | `logger.redactLogValue`, secret-name path denial, write-only encrypted provider keys |
| Plugin architecture | **Done, deliberately declarative** | Signed `.evolvpack`, no JS/shell/install hooks |
| Multi-agent runtime substrate | **Partial** | 11-state machine, plans, steps, evidence, budgets, leases — one executor |
| Snapshots / unlimited undo | **Gap** | Vault changes have undo; **project files do not** |
| Git commit before risky edits | **Gap** | Git is read-only (`status`, `diff`) |
| Post-edit validation with auto-revert | **Gap** | Validation exists, but as a separately approved action, not a gate |
| Session replay | **Gap** | The data exists and is ordered; there is no replay |
| Context engine (open files, git history) | **Gap** | Retrieval is semantic over memory/vault/project text only |

**Phase 1 is approximately 70% complete.** The remaining 30% is concentrated
almost entirely in *workspace-level* recoverability — the vault got the careful
treatment and the project workspace did not.

### The existing risk ladder

The brief proposes three tiers. The code already has six, with the dangerous
half disabled by default:

| Tier | Automatic | Default | Meaning |
| --- | --- | --- | --- |
| `read` | yes | on | Local read |
| `network-read` | yes | on | Bounded, fixed-destination fetch |
| `approval-write` | no | on | Produces a proposal only |
| `sensitive-write` | no | **off** | Direct write |
| `command` | no | **off** | Process execution |
| `destructive` | no | **off** | Deletion |

Keep this ladder. It is better than the three-tier model in the brief, and
lowering its resolution would be a regression.

---

## 1. Target architecture

```text
┌─ Electron main ────────────────────────────────────────────┐
│ lifecycle · safeStorage (DPAPI/keyring) · native pickers    │
│ folder grants · Piper/Whisper · updater                     │
└──────────────┬─────────────────────────────────────────────┘
               │ narrow IPC (no fs, no shell, no process)
┌─ Renderer (sandboxed) ─────────────────────────────────────┐
│ chat · approvals · rollback timeline · runs · marketplace   │
└──────────────┬─────────────────────────────────────────────┘
               │ authenticated loopback HTTP + NDJSON
┌─ Server ───────────────────────────────────────────────────┐
│ auth/CSRF boundary · routing · orchestration                │
│ per-request profile scope (AsyncLocalStorage + Proxy)       │
└──────────────┬─────────────────────────────────────────────┘
               │
┌─ Domain services ──────────────────────────────────────────┐
│ providers │ tools │ approvals │ agent-runtime │ goal-runner │
│ memory │ vault │ projects │ marketplace │ evolution         │
│                                                             │
│ NEW: snapshots │ shadow-workspace │ validation │ replay      │
└──────────────┬─────────────────────────────────────────────┘
               │
┌─ Storage ──────────────────────────────────────────────────┐
│ accounts.db  ·  profiles/<id>/evolv.db (WAL, ledgered)      │
│ NEW: profiles/<id>/blobs/  (content-addressed)              │
└────────────────────────────────────────────────────────────┘
```

Four new services. Everything else stays.

**`snapshots`** — content-addressed workspace capture. Hash every file, store
blobs once, store snapshots as manifests of hashes. Unlimited undo becomes
cheap because unchanged files cost nothing. This also solves an existing
problem the Stage 0 audit flagged: base64 images inflating the database. Move
them to the same blob store.

**`shadow-workspace`** — a copy-on-write overlay of the project. Edits apply
there first, validation runs there, and only a green result is offered for
promotion. This is the real content of the brief's "simulation" idea (§9).

**`validation`** — parse, syntax-check, and conflict-detect before; tests,
build, lint after. Runs *inside* the shadow, which resolves a contradiction in
the brief (§15, Risk 4).

**`replay`** — a reader over `run_events` and `audit_events`. The data is
already ordered and checkpointed; this is a view, not a new subsystem.

---

## 2. Folder structure

Additive. The current layout is sound and the discipline of `lib/` being pure
domain logic with no HTTP knowledge is worth preserving.

```text
electron/            desktop shell, IPC, native capabilities
lib/
  schema.mjs         all profile DDL as an ordered migration list
  database.mjs       ledger + repository
  approvals.mjs      one approval envelope for every effect
  tool-contracts.mjs risk ladder, signals, dry-run policy
  agent-runtime.mjs  run/plan/step state machine
  goal-runner.mjs    the first executor behind that runtime
  snapshots.mjs      NEW  content-addressed capture and restore
  blob-store.mjs     NEW  sha256 → file, shared by snapshots and attachments
  shadow.mjs         NEW  copy-on-write overlay, promote/discard
  validation.mjs     NEW  pre-parse and post-verify gates
  replay.mjs         NEW  ordered session reconstruction
server/              route modules, split by domain as they grow
public/              renderer (vanilla ESM, no build step)
packs/               bundled marketplace packs
docs/                stage documents and this roadmap
```

`server.mjs` is 3,200 lines and should be decomposed into `server/` route
modules the way `goal-routes.mjs` already was — one domain at a time, behind
existing tests, never as a big-bang rewrite.

---

## 3. Technology stack

The strongest recommendation in this document: **do not modernise the stack.**

Evolv has two runtime dependencies. There is no framework, no bundler, no
transpiler, no state library. That is why the whole system is auditable, why
`npm audit --omit=dev` reports zero, and why a security reviewer can read the
renderer top to bottom. A React/Vite/tRPC/Prisma rewrite would add hundreds of
transitive dependencies to a product whose entire pitch is trust. It would be
the single most damaging thing you could do.

Keep: Node ≥20, vanilla ESM, `better-sqlite3`, Electron, plain HTML/CSS/JS,
`node:test`.

Add only where a real gap exists:

| Need | Recommendation | Why this one |
| --- | --- | --- |
| Multi-language parse/syntax validation | **Tree-sitter (WASM)** | No native toolchain, one grammar per language, used by every serious editor |
| Structural diff / hunk review | **`diff` (jsdiff)** or hand-rolled Myers | Small, pure JS; current whole-file diffs are the weak point of the review UI |
| Content-addressed blobs | **Node `crypto` + fs** | No dependency needed; sha256 filenames and a `file_blobs` table |
| Executable plugin isolation (only if §11 route B) | **`node:worker_threads` + separate process, or WASM** | Avoid `vm`/`isolated-vm`; process boundaries are the only ones users can reason about |
| Embeddings | **Keep Ollama `nomic-embed-text`** | Local-first, already integrated, already degrades to lexical |
| 2D sandbox rendering (if ever) | **Canvas 2D, no engine** | A game engine is a large dependency for a visualisation |

---

## 4. Milestone roadmap

Ordered by trust earned per unit of work.

**M1 — Workspace recoverability (the actual headline feature).**
Content-addressed snapshots, automatic capture before any approved write,
one-click restore, rollback timeline UI. Ships the slogan. Until this exists,
"never lose work to AI mistakes" is not true for project files.

**M2 — Git integration.** Auto-commit to a dedicated `evolv/checkpoint` ref
before risky edits, so recovery survives Evolv being uninstalled and users can
inspect history with their own tools. Never commit to the user's branch.

**M3 — Shadow workspace and validation gates.** Edits apply to an overlay,
tests/lint/build run there, failure discards, success offers promotion.

**M4 — Session replay.** A view over existing ordered events.

**M5 — Context engine.** Active file, recent git history, open project files,
prior turns — assembled with a token budget rather than repeated prompting.

**M6 — Multi-agent roles.** Sequential, specialised executors behind the
existing runtime, sharing one approval envelope.

**M7 — Executable plugins**, only if §11 route B is chosen deliberately.

**M8 — Simulation UI.** The visual layer over M3, if it earns its place.

---

## 5. Database schema (additions only)

The profile database already has ~76 tables under an ordered, checksummed
migration ledger (`lib/schema.mjs`). Add migrations 15+; never edit an applied
one.

```sql
-- Content-addressed storage. One row per unique content, shared by snapshots
-- and message attachments.
CREATE TABLE file_blobs (
  sha256      TEXT PRIMARY KEY,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE workspace_snapshots (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,          -- 'pre-edit' | 'manual' | 'pre-run'
  tool_run_id   TEXT REFERENCES tool_runs(id) ON DELETE SET NULL,
  agent_run_id  TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  git_commit    TEXT NOT NULL DEFAULT '',
  file_count    INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_snapshots_project ON workspace_snapshots(project_id, created_at DESC);

-- A snapshot is a manifest of hashes. Unchanged files cost one row, no bytes.
CREATE TABLE snapshot_files (
  snapshot_id   TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  sha256        TEXT NOT NULL REFERENCES file_blobs(sha256),
  mode          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, relative_path)
);

CREATE TABLE shadow_sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  base_snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id),
  state        TEXT NOT NULL CHECK(state IN ('open','validated','failed','promoted','discarded')),
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);

CREATE TABLE validation_runs (
  id         TEXT PRIMARY KEY,
  shadow_id  TEXT REFERENCES shadow_sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- 'parse' | 'test' | 'lint' | 'build'
  passed     INTEGER NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  output     TEXT NOT NULL DEFAULT '', -- capped
  created_at TEXT NOT NULL
);

-- Multi-agent handoffs, auditable like everything else.
CREATE TABLE agent_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  from_role   TEXT NOT NULL,
  to_role     TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'handoff' | 'review' | 'question'
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

Retention: snapshots are cheap but not free. Keep all snapshots for the current
session, then thin to daily beyond 30 days, and garbage-collect blobs with no
referencing manifest.

---

## 6. API design

Extend the existing REST + NDJSON convention. Streaming endpoints emit typed
events; everything mutating requires the CSRF header and an authenticated
profile scope.

```text
POST   /api/projects/:id/snapshots            capture now
GET    /api/projects/:id/snapshots            timeline (paged)
GET    /api/snapshots/:id/diff                against working tree
POST   /api/snapshots/:id/restore             → returns a new pre-restore snapshot
DELETE /api/snapshots/:id

POST   /api/projects/:id/shadow               open an overlay
POST   /api/shadow/:id/apply                  stage edits into the overlay
POST   /api/shadow/:id/validate               NDJSON: parse → test → lint → build
POST   /api/shadow/:id/promote                requires approval; snapshots first
DELETE /api/shadow/:id                        discard

GET    /api/runs/:id/replay                   NDJSON: ordered event reconstruction
GET    /api/audit?since=&kind=                paged audit query
```

Invariant worth stating in code: **`promote` is the only endpoint that can
change a real project file, and it always captures a snapshot first.** One
choke point, one place to audit.

---

## 7. Memory architecture

Largely built. Four layers, retrieved with a budget rather than concatenated:

1. **Working context** — current conversation, active file, recent diffs.
2. **Project memory** — typed graph (project/task/decision/preference/note),
   linked, semantically retrieved. Model-extracted records stay `proposed`
   until approved.
3. **Vault** — Obsidian, live-indexed, authoritative when connected, one vault
   per profile, cloud-withheld unless explicitly permitted per provider.
4. **Evidence** — run artifacts, tool outputs, validation results.

The gap is **assembly**, not storage. Today each source is retrieved
independently. Introduce a context builder with an explicit token budget and a
visible breakdown of what it included and what it dropped — transparency
applies to context too, and "why did it not know that?" is the most common
trust failure in AI tooling.

---

## 8. Agent architecture

The runtime already models runs, plans, steps, attempts, evidence, budgets,
leases, checkpoints, and eleven legal states with enforced transitions. It has
one executor (`goal-runner-v1`). Multi-agent means **more executors behind the
same runtime**, not a new system.

```text
AgentRuntime  (durable state, budgets, approvals, events)
   ├── goal-runner-v1        general planner/executor  [exists]
   ├── reviewer-v1           reads a diff, produces findings
   ├── tester-v1             runs validation in a shadow, reports
   ├── security-v1           scans a diff for secrets and risky patterns
   └── documenter-v1         proposes docs from approved changes
```

Roles hand off through `agent_messages`. Each role gets its own budget. All of
them share one approval envelope, so a user never faces per-agent approval
fatigue.

**Do not build voting.** Concurrent agents voting on solutions multiplies cost
and latency, is hard to audit, and rarely beats one strong model with good
context. Sequential specialists with explicit handoffs are cheaper, auditable,
and explainable — which matters more here than raw capability.

---

## 9. Sandbox architecture

This is where the brief and I disagree most, so I will be direct.

The brief describes two different things under one name:

**(a) Simulate before acting.** "The AI performs the work inside the sandbox;
if successful, generate the real edit." This is genuinely valuable and is
exactly the shadow workspace in M3. It is weeks of work and it directly serves
the slogan.

**(b) A 2D world where an agent walks around, picks up tool objects, and
perceives distance and inventory.** This does not make edits safer. Spatial
reasoning over file objects is a *visualisation* of work, not a mechanism that
prevents damage. An agent "walking to" a compiler object does not validate
anything that running the compiler in an overlay does not validate better.

My recommendation: build (a) and call it the simulation layer. Treat (b) as an
optional presentation skin over (a), much later, and be honest internally that
its purpose is legibility and delight — not correctness. If it is built, the
sprite and world should render *real* run state (this step is executing, this
validation failed), never a fictional animation of work that is not happening.
An animation that implies work that did not occur is the opposite of
transparency and would undermine the product's core claim.

The object model in the brief is still useful, minus the physics: files,
folders, git, compilers, memory, network, plugins and tools already are objects
with actions in this codebase. Formalising a common `Object → actions` contract
is worthwhile on its own merits, and it is what a future SDK would target.

---

## 10. Security model

Already strong. Preserve, then extend.

Existing: loopback-only binding; Host/Origin/Fetch-Metadata checks; salted
scrypt with constant-time comparison; hashed single-use recovery codes; session
idle and absolute expiry; CSRF on every mutation; sandboxed renderer with
context isolation and no Node integration; narrow IPC; per-profile SQLite
isolation; write-only encrypted provider keys; path containment with symlink
and secret-file denial; DNS re-resolution before each custom-provider
connection; redirect denial; declarative-only plugins.

Additions required by the new subsystems:

- **Snapshots are secrets.** A snapshot of a project captures `.env` files if
  they are in scope. Reuse the existing `SECRET_NAMES`/`DENIED_SEGMENTS` denial
  list at capture time, and record what was skipped so the exclusion is
  visible rather than silent.
- **Blob store is inside the profile directory**, inherits profile isolation,
  and is excluded from portable export like vault contents already are.
- **Validation runs inside the shadow**, with the existing allowlisted command
  set (`test`, `lint`, `check`, `typecheck`, `build`, `format:check`) and the
  existing scrubbed environment. Never `npm install` as part of validation.
- **Leak detection before responses** (a brief requirement): scan outbound
  model payloads for high-entropy strings and known key shapes, and block on
  match. This is the one genuinely new security control, and it belongs at the
  provider boundary where every request already funnels through `config()`.

---

## 11. Plugin system — the decision that matters most

The current Marketplace is **declarative by design**: packs may register
agents, prompt commands, workflows, knowledge, documentation, and validated
configuration. They cannot execute JavaScript, run shell commands, install
packages, or hook installation. Permissions are shown before install and
re-approved on update. Packs are Ed25519-signed.

The brief asks for plugins that add *tools, deployments, and custom agents*.
Tools and deployments mean executing third-party code. That is a different
security model, not an extension of this one.

**Route A — stay declarative.** Plugins compose existing approved built-ins
(this is what the tool-recipe system already does: up to eight sequential calls
to enabled built-ins, no code, no URLs, no nesting). Safe, limited, and honest.

**Route B — executable plugins.** Requires: a separate OS process, not `vm` or
`isolated-vm`; a capability manifest declaring exactly which tools and paths it
may touch; brokered IPC where the host performs every effect on the plugin's
behalf and applies the same risk ladder; resource and time budgets; mandatory
signing with publisher identity; and a review process for anything listed
publicly.

Route B is a quarter of engineering work on its own. Do not drift into it
accidentally by loosening the pack format. Decide it explicitly. If the answer
is "not yet", say so in the docs so contributors do not assume otherwise.

---

## 12. UI/UX

**Rollback timeline** — the flagship surface. A vertical time axis of
snapshots; each entry shows what changed, why, which tool or run caused it, and
whether validation passed. Hovering previews the diff; clicking restores, which
itself creates a snapshot so restore is undoable. This screen is what makes the
slogan legible.

**Approval card** — evolve the current diff proposal. Header states the effect
in one sentence and its risk tier. Body is a hunk-level diff, not whole-file.
Footer shows validation results *before* the decision, so approval is informed
rather than hopeful. Approve / Reject / Approve-and-remember-for-this-session.

**Shadow indicator** — a persistent, unmissable banner while a shadow session
is open: "Working in a copy. Nothing has changed on disk." with file count and
a promote/discard pair.

**Session replay** — a scrubber over the run's event log, showing state
transitions, tool calls, evidence, and approvals in order.

**Command palette** — natural-language entry that resolves to *concrete
proposed actions with risk tiers shown before execution*, never a free-text
instruction that silently dispatches.

The `/agent` composer command shipped in this branch is the pattern to follow:
one entry point, in the place people already type, resolving to a reviewable
plan.

---

## 13. Timeline

Assumes one experienced developer working steadily, with the existing test
discipline maintained. Halve for two people who split cleanly; do not assume
better than that.

| Milestone | Estimate | Ships |
| --- | --- | --- |
| M1 snapshots + timeline | 3–4 weeks | The slogan becomes true |
| M2 git checkpoints | 1–2 weeks | Recovery survives Evolv |
| M3 shadow + validation | 4–6 weeks | Failed edits never touch disk |
| **MVP of the trust product** | **~3 months** | Defensible "never lose work" claim |
| M4 replay | 2 weeks | |
| M5 context engine | 3–4 weeks | |
| M6 multi-agent roles | 4–6 weeks | |
| **1.0 production** | **~6–7 months** | Plus signing, docs, real Linux verification |
| M7 executable plugins | 8–12 weeks | Only if route B is chosen |
| M8 simulation UI | 6–10 weeks | Optional, presentation only |

Before 1.0, three items already identified and still open: Authenticode signing
(currently unsigned, SmartScreen warns), a verified Linux packaged build, and
decomposition of `server.mjs`.

---

## 14. Technology per subsystem

| Subsystem | Technology | Note |
| --- | --- | --- |
| Runtime | Node ≥20, ESM | Unchanged |
| Desktop | Electron 41.x | Stay on the newest 41 patch; 42 lacks a `better-sqlite3` prebuild |
| Storage | `better-sqlite3`, WAL | Synchronous API is a feature for transactional correctness |
| Migrations | In-house ledger | Built this branch; ordered, checksummed |
| Blobs | `node:crypto` + fs | sha256-named files, no dependency |
| Parsing | Tree-sitter WASM | Per-language grammars, no native build |
| Diff | jsdiff or hand-rolled Myers | Needed for hunk-level review |
| Validation execution | `child_process` with allowlist + scrubbed env | Reuse the existing runner |
| Embeddings | Ollama `nomic-embed-text` | Lexical fallback already implemented |
| Providers | `fetch` | Streaming already normalised across five providers |
| Renderer | Vanilla ESM | No framework — this is a security property |
| Tests | `node:test` | Plus the explicit runner added this branch |
| Packaging | Custom `pack-win.mjs` | Forge cannot handle this toolchain reliably |

---

## 15. Risks, tradeoffs, scalability

**Risk 1 — Tiering the product at all.** The brief proposed a free tier and a
paid tier, with automatic checkpoints and unlimited rollback behind the paid
one. **That plan is withdrawn: Evolv has no paywalls.** Every feature in this
document — snapshots, rollback, validation, multi-agent, the sandbox, plugins
— is available to every user.

This removes a design constraint rather than adding one, and simplifies real
architecture. There is no entitlement check, no licence state, no tier flag
threaded through the approval path, no billing integration, no account service
to run, and no upgrade prompt to design around. The risk to actively avoid is
reintroducing tiering by accident: a "pro" flag added for one feature becomes
a plumbing dependency everywhere. Nothing in the schema, the API, or the
approval envelope should carry an entitlement concept.

Gating recoverability would also have been incoherent on its own terms. A
free tier that edits files without a safety net is exactly the product the
slogan promises not to ship, and exactly the configuration that produces the
"Evolv destroyed my project" story. Not charging for anything makes that
failure impossible by construction.

**Risk 2 — Sandbox scope.** A 2D world with perception, inventory, physics and
an SDK is a multi-quarter project that does not itself make anything safer
(§9). The failure mode is months spent on the metaphor while the actual safety
gap — no project-file undo — stays open. Mitigation: M1–M3 first, and the
visual layer only over real run state.

**Risk 3 — Executable plugins.** Would invalidate the current, genuinely
defensible claim that packs cannot run code. Mitigation: decide route A or B
explicitly (§11); if B, budget a full quarter and a review process.

**Risk 4 — "Validate then auto-revert" versus "commands always need
approval".** These two brief requirements contradict each other: running tests
is process execution, which the risk ladder puts behind explicit approval.
Resolution: validation runs **inside the shadow**, where it cannot touch the
real workspace, using the existing allowlist. Approval attaches to
*promotion*, not to the validation run. This preserves both properties.

**Risk 5 — Snapshot storage growth.** A large repository snapshotted on every
edit could grow quickly. Mitigation: content addressing means only changed
files consume bytes; plus the existing denial list, a per-file size cap, an
index cap, retention thinning, and blob garbage collection.

**Risk 6 — Approval fatigue.** More safety means more prompts, and users who
click through every dialog are less safe than users who read a few.
Mitigation: keep automatic tiers genuinely automatic, batch related effects
into one envelope, show validation results before the decision, and offer
session-scoped "remember this" for repeated low-risk patterns.

**Risk 7 — `server.mjs` at 3,200 lines.** Every new subsystem makes it worse.
Mitigation: continue the `server/goal-routes.mjs` pattern — extract one domain
at a time, behind existing tests.

**Risk 8 — Token cost of the context engine.** Richer context means larger,
slower, more expensive requests, and cloud providers bill for it. Mitigation:
explicit budget, visible breakdown of inclusions and exclusions, and local
models as the default path.

### Scalability

The honest scaling boundaries are local-first ones. Semantic retrieval decodes
vectors and scans in-process — fine for thousands of records, not for hundreds
of thousands; add an ANN index when a real user hits it, not before.
`getConversation()` loads every message and the renderer rebuilds the whole DOM
— fix with pagination and virtualisation when long projects demand it. Neither
is urgent; both should be measured rather than guessed.

---

## Decisions

1. **No paywalls.** Every feature ships to every user. Nothing in the schema,
   the API, or the approval envelope carries an entitlement concept, and
   nothing should acquire one later.
2. **Build the shadow workspace, not the 2D world — at least first.** One is
   the safety mechanism; the other is a picture of it.
3. **Keep plugins declarative until you deliberately decide otherwise.** It is
   currently one of the few genuinely unusual security claims Evolv can make.

Everything else in the brief is either already built or straightforwardly
buildable on what exists.
