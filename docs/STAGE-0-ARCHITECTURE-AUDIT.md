# Evolv Stage 0 Architecture Audit

Date: 2026-08-01  
Audited repository version: `0.4.0` (the repository is newer than the `0.2.0` product context in the request)

## Executive conclusion

Evolv is already a substantial local-first AI workspace, not an empty prototype. Its strongest foundations are profile isolation, authenticated loopback access, SQLite persistence, provider adapters, bounded tools, explicit approval for writes, Obsidian integration, reversible prompt upgrades, and broad automated coverage.

The requested overhaul should not replace those systems. The main missing product is a first-class, durable **agent run**: there is no persisted objective/plan/task state machine, project workspace boundary, resumable run scheduler, artifact model, or run-level evaluation record. Today, advanced behavior is implemented inside a persisted chat/tool loop. That loop is useful and should become the first execution adapter behind a new run runtime rather than being discarded.

The safest migration is a strangler-style refactor: introduce typed contracts, real ordered migrations, structured logs, and a provider facade beside the working code; then move one route and one feature at a time behind those contracts. Preserve the current APIs until the replacement path has parity tests.

## Audit evidence

- Read the desktop shell, preload bridge, localhost server, all 20 `lib/*.mjs` modules, renderer shell, build scripts, documentation, and 22 test files.
- Full test suite on Windows: **136 passed, 0 failed**.
- Corrected Windows x64 ZIP build completed successfully with Electron 41.9.2 and an Electron-ABI `better-sqlite3` native module.
- Production dependency audit: **0 known vulnerabilities** across 40 production dependencies.
- Full dependency audit: **21 development/build-chain findings** (18 moderate, 2 high, 1 critical), mainly under Electron Forge/rebuild. The current `tar` override is `7.5.16`, which is now below the advisory-safe range.
- The directory named `.git` is empty; this workspace is not currently a usable Git repository.

## 1. Current architecture

```text
Electron main process
  -> starts loopback HTTP server on a random 127.0.0.1 port
  -> opens a sandboxed BrowserWindow
  -> owns safeStorage, folder pickers, Obsidian grants, Piper, Whisper.cpp
  -> exposes narrow preload APIs

Renderer (plain HTML/CSS/ES modules)
  -> authenticated fetch + CSRF
  -> chat, intelligence, evolution, versions, memory, tools, Marketplace
  -> NDJSON streaming

server.mjs
  -> authentication and security boundary
  -> all HTTP routing and chat orchestration
  -> per-request profile scope through AsyncLocalStorage
  -> retrieval, model routing, provider calls, tool loop, approvals

Profile context
  -> profile SQLite database
  -> provider service
  -> tool registry and engineering actions
  -> Obsidian vault service
  -> tool recipes/macros
  -> Marketplace service
```

### Desktop shell

- `electron/main.mjs` owns lifecycle, the BrowserWindow, permission decisions, `safeStorage`, native pickers, Obsidian grants, and local voice services.
- Security settings are strong: renderer sandboxing, context isolation, Node integration off, menu removed, external windows denied, off-origin navigation denied, and camera/microphone limited to the generated loopback origin.
- `electron/preload.cjs` exposes narrow voice, Obsidian, and application-exit operations. It does not expose filesystem, process, shell, credentials, or unrestricted IPC.
- Missing shell capabilities: structured crash logs, crash recovery UI, native notifications, update service, tray behavior, and centrally validated IPC schemas.

### Local server

- `server.mjs` is a 2,892-line ESM module containing bootstrap, security middleware, validation, route dispatch, retrieval, legacy and persisted chat flows, model/tool orchestration, intelligence evaluation, imports, and static serving.
- It binds only to `127.0.0.1`, validates `Host`, `Origin`, Fetch Metadata, CSRF, content type, body limits, and authentication before serving the application or APIs.
- It emits normalized NDJSON events for routing, metadata, content, reasoning, tool requests/results, errors, and completion.
- Profile services are selected through `AsyncLocalStorage`; data access proxies prevent a request from using services without an authenticated profile context.

### Storage

- `data/accounts.db`: local usernames, salted scrypt credential records, recovery hashes, and bounded account audit events.
- `data/profiles/<user-id>/evolv.db`: conversations, messages, settings, knowledge, memory, tools, providers, routing, evaluation, Marketplace, Obsidian indexes, and proposals.
- SQLite uses WAL, foreign keys, prepared statements, transactions, busy timeout, integrity checks, backups, and non-destructive imports.
- Large or external state also exists outside SQLite:
  - Obsidian vault contents are authoritative when connected.
  - `obsidian-vault-owners.json` stores cross-profile vault claims.
  - `voice.json` stores device voice paths.
  - renderer `localStorage` stores device preferences and one-time migration inputs.
  - images are currently stored as base64 inside message metadata in SQLite.
- The primary database declares schema version 5 and 47 tables exist across the database and feature services.

### Model gateway

- `lib/providers.mjs` normalizes Ollama, OpenAI-compatible APIs, OpenAI, Anthropic, Gemini, OpenRouter, and one custom endpoint.
- It supports discovery, streamed chat, images, reasoning deltas, tool calls, cancellation signals, credential rejection handling, redirect denial, and conservative capability metadata.
- API keys are encrypted by Electron `safeStorage`; insecure Linux `basic_text` storage is rejected.
- Embeddings remain an Ollama-specific server function rather than part of the provider interface.
- Usage, billing cost, retry policy, context enforcement, and provider-neutral error/health records are incomplete.

### Chat and tool runtime

- `handlePersistedChat` is the real execution engine today.
- Each turn persists user, assistant, and tool messages and enforces four model rounds and six tool calls.
- It supports Auto routing, capability checks, knowledge/memory retrieval, tool call deduplication, aborts, stream watchdogs, tool approvals, and continuation after approval.
- This is not yet a general agent state machine. It has no durable objective, plan, current task, run state, step graph, pause/resume checkpoint, run budgets, artifact set, or run-level evaluation.

### Tool system

- `lib/tools.mjs` is a registry with input schemas, risk, permission, timeout, availability, enable state, validation, bounded output, and audit records.
- Read tools cover calculations, time, JSON, text transformations, hashes, knowledge/memory, workspace files, Obsidian, and fixed no-key APIs.
- Write/research/command actions are proposal-only until approved. File edits are exact-text, size-limited, stale-safe, project-relative, and atomic. Commands are allowlisted and run without a shell.
- Generated tools are declarative recipes/macros limited to enabled built-ins; they cannot add executable code or permissions.
- Missing contract elements: output schemas, standardized error taxonomy, universal dry-run support, abort signals that cancel underlying work, and the requested five-class risk vocabulary.

### Memory, knowledge, and evolution

- Working context is assembled per turn from recent messages, approved knowledge, project-memory nodes, and optionally Obsidian chunks.
- Project-memory nodes and edges support proposed/active/resolved/archived records.
- Post-turn extraction creates proposals only. Approval is required before activation or vault writes.
- Prompt versions, feedback cases, blind comparisons, routing events, routing preference candidates, upgrade decisions, and rollback are durable.
- The current evaluation system evaluates prompt/routing candidates, not complete agent runs.
- The built-in knowledge UI accepts bounded text. Obsidian handles Markdown and Canvas. PDF, image, source-tree, and general document ingestion pipelines are not implemented.

### Renderer

- `public/app.js` is a 4,009-line plain JavaScript module with global mutable state, rendering, data access, streaming, voice, gestures, Marketplace, dialogs, and every feature controller.
- `public/index.html` contains all major screens in one document. Views are Chat, Evolution, Intelligence, Versions, Mind, Tools, and Marketplace.
- Dynamic content is escaped before controlled Markdown rendering. Model text, tool data, vault data, and pack metadata are not inserted as executable HTML.
- Major views are visually hidden, not code-split or lazy-loaded. Conversations and messages are rebuilt as complete DOM lists.

### Build and release

- `scripts/pack-win.mjs` packages only runtime source/dependencies, downloads the matching Electron ABI native module, validates platform behavior, adds itch manifests, and creates ZIP/tar archives.
- Windows build and signing gates exist; the current personal build is unsigned.
- Linux must be built on Linux Mint to preserve native ABI and permissions. A validator rejects Windows voice binaries and non-ELF SQLite modules.
- No auto-update or release rollback channel exists inside the app.

## 2. Current working features

Verified by code and tests:

- Windows Electron app and browser development mode.
- Local profiles, password/recovery flows, memory-only sessions, CSRF, lock/logout/change password, and profile isolation.
- Secure key storage and provider configuration for six provider types.
- Persistent streaming conversations, reasoning, images, search, rename, archive, trash, restore, export, import, and backup.
- Capability-aware model controls and optional Auto Balanced routing with visible fallback reporting and cloud opt-in.
- Audited safe tools, fixed-host public APIs, tool loop limits, approval-gated engineering actions, Obsidian diffs, and continuation after approval.
- Project-memory graph, review-only continual memory proposals, Obsidian Markdown/Canvas indexing, backlinks, citations, watcher sync, and cloud-vault withholding.
- Prompt versioning, feedback cases, blind prompt comparison, routing proposals, explicit promotion, rejection, and rollback.
- Declarative generated tool recipes, macros, Marketplace packs, permission review, signed catalog support, and free-form pack chat.
- Piper text-to-speech, Whisper.cpp push-to-talk, MediaPipe gestures, diagnostics, and capability fallbacks.
- Windows packaging, Linux packaging scripts/validation, itch.io manifests, Butler integration, and optional Authenticode gates.

## 3. Broken or incomplete features

### Highest priority

1. **No durable agent-run domain.** Chat messages and tool runs cannot represent the requested plan/execute/observe/evaluate/revise lifecycle or its states.
2. **No real project workspace.** A memory node named `project` and an optional pack folder are not a project boundary with files, tasks, artifacts, runs, instructions, and scoped permissions.
3. **No crash-resumable execution.** A process crash can leave assistant messages in `streaming`; there is no startup reconciliation or checkpoint from which an agent run can resume.
4. **Migrations are not truly ordered.** Schema version 5 is recorded, but the main database creates the latest schema in one block and feature constructors create/alter their own tables. Upgrade behavior depends on service initialization instead of an ordered migration ledger.
5. **Development/build dependency vulnerabilities.** Production dependencies are clean, but the packaging chain currently reports 21 findings, including a critical `tar` advisory. Release tooling must be repaired before a trusted public build.
6. **No usable source-control history.** The `.git` directory is empty. There is no reliable baseline, review diff, rollback, or logical commit history for the overhaul.

### Product gaps

- No objective/plan/task/run/step/artifact schema.
- No pause/resume/cancel state machine or persisted runtime/token/cost/tool budgets.
- No Home, Projects, Agents, Runs, or dedicated Models workspace.
- No exportable run report or run-level files-changed summary.
- No deterministic evolution benchmark runner tied to strategy promotion.
- No PDF/image/source-folder knowledge ingestion pipeline.
- No token usage capture, actual provider cost accounting, or resource-usage display.
- No low-resource mode, local-model request scheduler, or background-work control panel.
- No update service, system tray, native notification flow, or user-facing crash recovery.
- Linux scripts exist, but a real Linux Mint packaged smoke test was not performed on this Windows machine.

### Confirmed UI defects addressed immediately before this audit

- Marketplace permission dialogs mixed native and simulated dialog state and could become impossible to dismiss. The corrected dialog now closes through X, Cancel, Escape, or backdrop click.
- The login logo was behind the authentication gate and rendered as broken. It is now an explicitly public login asset.
- The desktop lock screen now has a narrow IPC-backed **Exit Evolv** button.

## 4. Security review

### Existing strengths

- Loopback-only binding plus Host/Origin/Fetch-Metadata checks.
- Strong password hashing, constant-time comparisons, hashed recovery codes, session expiry, session invalidation, rate limits, HttpOnly SameSite cookies, and CSRF tokens.
- Sandboxed renderer, context isolation, no Node integration, narrow IPC, origin-restricted media, external-navigation denial, CSP, frame denial, MIME sniffing denial, and no-referrer policy.
- Write-only encrypted provider keys, no credential export, sanitized tool logs, and generic request-ID errors.
- Path containment, symlink checks, protected-file rules, size caps, no-shell execution, allowlisted commands, DNS/private-network checks for research, redirect denial, atomic writes, stale edit detection, and explicit approvals.
- Vault excerpts are blocked from cloud providers until individually enabled.

### Weaknesses and hardening work

1. **IPC validation is handwritten and distributed.** Preload is narrow, but main-process handlers should validate every payload against shared schemas and return typed errors.
2. **Custom-provider DNS validation is save-time only.** A hostname can change after validation. Re-resolve and enforce the public/loopback policy immediately before each connection; apply the same rule to remote catalog endpoints.
3. **Tool timeouts do not universally abort underlying work.** `Promise.race` can report a timeout while a non-cooperative operation continues. Add an `AbortSignal` to the tool contract and require handlers to honor it.
4. **Core/project boundary is unclear in development.** The default engineering workspace is the Evolv source root. A future project tool must never silently inherit access to application source or security files.
5. **Accounts and external metadata have separate recovery paths.** Profile backups do not provide a coordinated snapshot of `accounts.db`, vault claims, and device configuration.
6. **SQLite and backups are plaintext.** This is documented and acceptable for the current local threat model, but the UI should keep it explicit and optionally support OS-encrypted backup archives later.
7. **Build tooling has known advisories.** These are development dependencies, not shipped runtime modules, but they process archives and packages and therefore matter to release integrity.
8. **No signed release by default.** The gate exists, but unsigned builds remain vulnerable to replacement and create SmartScreen friction.

## 5. Performance review

1. `database.getState()` loads all feedback, prompt versions, knowledge, embeddings, and architecture proposals. `saveState()` deletes and reinserts four whole tables for many small mutations. This will scale poorly and creates avoidable race windows.
2. `getConversation()` loads every message; `renderMessages()` destroys and rebuilds the complete message DOM. Long projects will become slow and memory-heavy.
3. `public/app.js`, all views, and most controllers load eagerly. There is no screen-level code splitting or virtualization.
4. Up to 80 chat messages plus images can be placed into a model request without token-aware trimming. `numCtx` is a user number, not an enforced provider-aware context budget.
5. There is no provider/local-model scheduler. Chat, memory extraction, evaluation, model discovery, and indexing can compete for modest CPU/RAM.
6. Semantic retrieval decodes vectors into JavaScript arrays and scans them in-process. This is acceptable for small stores but not a scalable index.
7. The voice payload is **257.8 MB** before Electron: a 141 MB Whisper model, a 60 MB Piper model, many unused Whisper executables/CPU DLLs, and a complete espeak data tree. The current Windows ZIP is about 370 MB.
8. Images up to 15 MB per message are retained as base64 in SQLite metadata. Move binary artifacts to content-addressed files and store references in SQLite.
9. Obsidian reconciliation is bounded and debounced, but the app lacks one global background-work budget and visible queue controls.

## 6. Duplicate, obsolete, or unnecessary systems

- Two chat paths remain: legacy non-persisted `/api/chat` and persisted `/api/conversations/:id/chat`. Only the latter is used by the renderer.
- The renderer still contains a full legacy wake-word/continuous-listening pipeline, while the current UI is push-to-talk and the preload no longer exposes those methods.
- `server.mjs` duplicates orchestration concerns that also belong to provider, intelligence, memory, and tool modules.
- Table creation is duplicated across the core database and feature service constructors instead of one migration system.
- `architecture_proposals`, prompt proposals, intelligence upgrades, tool recipe proposals, engineering actions, vault changes, and Marketplace permissions each have separate approval shapes. Their policies differ legitimately, but the lifecycle and audit envelope should share one approval service.
- `Evolv-Personal-0.4.0-FULL`, multiple `out*` trees, and an empty `Evolv-Personal-0.4.0` directory duplicate hundreds of megabytes beside the source and make it easy to edit or ship the wrong copy. They are excluded by the custom packer, but should live under a clearly ignored release/archive directory outside the working source.
- `forge.config.cjs` and the custom packer partly overlap. The custom packer is the reliable path today; Forge config should either become a thin shared configuration or be retired after parity is proven.

## 7. Data-migration risks

1. DDL spread across constructors means a profile may not receive feature tables until that service initializes.
2. `schema_migrations` records only the current version, not every ordered, checksum-verified migration.
3. `accounts.db` has no migration ledger or coordinated backup policy.
4. Legacy database-to-owner-profile migration copies a live database file with `copyFileSync`; a SQLite backup operation is safer when WAL files exist.
5. Portable import validates structure, but schema version 1 exports will eventually need explicit version-to-version transforms rather than one permissive importer.
6. Provider secrets are intentionally machine-bound and excluded from export; cross-machine restores must clearly require key re-entry.
7. Obsidian connection ownership and voice configuration live outside profile export and can become stale after folder moves or OS migration.
8. Base64 images and future artifacts will inflate database backups unless extracted before the run/workspace migration.
9. Full-table `saveState()` operations can overwrite concurrent background changes because they persist a stale in-memory aggregate.
10. There is no automated fixture matrix that upgrades real schema snapshots from every prior release.

## 8. Proposed target architecture

```text
src/shared
  contracts, schemas, errors, IDs, events

src/main
  Electron lifecycle, windows, IPC router, permissions, secure storage,
  notifications, updater, crash/log host

src/server
  HTTP adapter, authentication middleware, API routers, streaming transport

src/domain
  projects, agent-runs, approvals, tools, memory, knowledge,
  evaluation, strategies, marketplace

src/application
  use cases and orchestration; no provider/filesystem/Electron details

src/infra
  SQLite repositories + ordered migrations, artifact store,
  provider adapters, Ollama queue, filesystem sandbox, structured logger

src/renderer
  routed/lazy screens, typed API client, per-screen state, virtual lists
```

### Core contracts

- `ModelGateway`: discover, health, capabilities, stream, embed, estimate, usage, cancel, and normalized errors.
- `AgentRun`: objective, plan revision, current task, state, budgets, checkpoints, steps, events, artifacts, and evaluation.
- `ToolDefinition<I,O>`: input/output schemas, risk class, permission set, timeout, dry run, abort signal, and typed failure.
- `ApprovalRequest`: resource, proposed effect, before/after evidence, expiry, decision, execution result, and continuation checkpoint.
- `Project`: explicit filesystem grants, instructions, tasks, knowledge, runs, artifacts, decisions, and retention policy.
- `MemoryEntry`: memory type, source, scope, confidence, approval, expiration, tags, relation, and last use.
- `StrategyVersion`: target policy, evidence, benchmark comparison, decision, active hash, and rollback pointer.

### Runtime rule

The run engine writes an event and checkpoint **before and after** each effect. State transitions occur in a transaction. The runner leases one runnable step at a time, honors budgets, and returns to `waiting_for_approval` before any sensitive action. Restart recovery converts abandoned leases to `paused` or `failed-recoverable`; it never guesses that an effect completed.

## 9. Exact staged implementation plan

### Stage 0 - audit (this document)

- Freeze the working 0.4.0 behavior as the compatibility baseline.
- Keep the corrected exit/dialog/login fixes and their tests.
- Do not begin the agent rewrite yet.

Exit evidence: 136 tests pass; Windows ZIP builds; architecture and risks documented.

### Stage 1 - stable foundation

1. Establish a real Git baseline and move release copies outside the source tree.
2. Add TypeScript in check-only mode for new modules; do not convert the renderer/server wholesale.
3. Add shared schemas for IPC, provider requests/events, errors, tool definitions, and identifiers.
4. Introduce an ordered transactional migrator with checksums and fixtures for schema versions 1-5; move constructor DDL into migrations without changing tables.
5. Replace full-state table rewrites with focused repositories and row-level mutations.
6. Add structured rotating logs with redaction, correlation IDs, renderer crash records, and exportable diagnostics.
7. Reconcile abandoned `streaming` messages on startup.
8. Extract the current provider behavior behind `ModelGateway`; add provider-neutral usage, health, timeouts, cancellation, bounded retries, context metadata, and embeddings.
9. Repair the Electron Forge/rebuild dependency audit without downgrading Electron or weakening native-module validation.
10. Run tests after every increment and a packaged Windows smoke test at the end.

Stage 1 exit: no API/UI regression, ordered migration upgrade tests pass, production and build dependency gates pass or have a documented non-exploitable exception, logs contain no secrets, and the packaged app opens existing profiles.

### Stage 2 - agent runtime

1. Add `agent_runs`, `run_plans`, `run_steps`, `run_events`, `run_checkpoints`, and `run_budgets` tables.
2. Implement the explicit state machine: idle, planning, waiting_for_approval, executing, observing, evaluating, revising, paused, completed, failed, cancelled.
3. Wrap the existing chat/tool loop as the first run executor.
4. Add maximum steps/runtime/tool calls/retries/tokens/estimated cost.
5. Add pause, resume, cancel, leases, duplicate-run prevention, startup recovery, and deterministic state-transition tests.

### Stage 3 - tool registry

1. Generalize existing tools into the typed input/output contract.
2. Add shared risk classes and approval policy without broadening current permissions.
3. Add true abortable timeouts and dry-run results.
4. Route engineering actions, Obsidian diffs, recipes, and macros through one approval envelope while retaining their specialized validators.
5. Keep destructive tools disabled until separately designed and tested.

### Stage 4 - projects, memory, and knowledge

1. Add projects, project grants, tasks, notes, artifacts, files, decisions, and run associations.
2. Make filesystem access originate only from explicit project grants.
3. Migrate existing project memory into the default personal project non-destructively.
4. Separate working, project, approved-long-term, strategy, and failure memory.
5. Add incremental parsers for Markdown, text, source, PDF, and images; store binaries/artifacts on disk by content hash and metadata in SQLite.
6. Add source citations, re-index/delete/status flows, and workspace isolation tests.

### Stage 5 - evaluation and evolution

1. Add run-level evaluators and evidence records for goal completion, grounding, tools, quality, efficiency, latency, tokens, cost, corrections, and recurring failures.
2. Add deterministic benchmark fixtures for document citations, code defect detection, task planning, multi-tool limits, and recovery from tool failure.
3. Store successful/failure strategies as candidates.
4. Compare candidates against the active strategy and require explicit promotion.
5. Preserve immutable safety, permission, credential, and application-code boundaries.

### Stage 6 - connected interface overhaul

1. Add Home, Projects, Agents, Runs, Tools, Knowledge, Evolution Lab, Models, and Settings routes.
2. Build the run timeline from persisted run events, not mock data.
3. Add plan review, approvals, live steps, files changed, evaluation, pause/cancel/resume, and report export.
4. Split renderer controllers by screen, lazy-load major screens, and virtualize conversations, messages, runs, and tool history.
5. Preserve accessibility, keyboard navigation, 1366x768 behavior, and clear local/cloud labels.

### Stage 7 - reliability and release

1. Coordinate account/profile/project backups and recovery drills.
2. Add crash recovery, corrupted-state quarantine, diagnostics export, resource telemetry, low-resource mode, and a single Ollama/background scheduler.
3. Trim optional voice binaries or ship voice packs separately.
4. Add signed Windows and real Linux Mint CI/build smoke tests.
5. Add update channels, rollback, demo project, user documentation, migration guide, and release notes.

## 10. Smallest set of files that should change first

The first Stage 1 increment should remain small and behavior-preserving:

1. `package.json` - add check/typecheck/migration/log tests and repair audited build dependencies only after compatibility verification.
2. `src/shared/contracts.ts` - new provider, IPC, error, tool, and event types.
3. `src/shared/schemas.ts` - new runtime validators used at trust boundaries.
4. `src/infra/logger.ts` - new redacting structured logger.
5. `src/infra/migrations/index.ts` - new ordered migration runner.
6. `src/infra/migrations/001-005-baseline.ts` - checksummed declarations of existing schema history; no destructive SQL.
7. `electron/main.mjs` - call typed IPC validation and crash logging adapters.
8. `server.mjs` - only bootstrap the migrator/logger and delegate normalized provider calls; do not split all routes in the first increment.
9. `lib/database.mjs` - stop creating feature schema ad hoc once migration parity tests pass; add focused mutation methods before removing `saveState()`.
10. `test/migrations.test.mjs`, `test/ipc.test.mjs`, and provider contract tests - prove compatibility before any UI refactor.

Do not change `public/index.html`, replace the renderer framework, or redesign navigation in the first Stage 1 increment. The foundation must prove existing profiles, chat, tools, approvals, providers, and packaging still work before the user experience is moved.

## Recommended first decision

Approve Stage 1 only as a sequence of small compatibility changes. The first checkpoint should be: real source-control baseline, dependency remediation, typed boundary contracts, ordered migration fixtures, structured logging, and startup reconciliation. Do not start the new agent UI until that checkpoint passes the existing test and packaged-build gates.
