# Evolv — architecture

How the pieces fit, drawn from the code rather than from memory. Every box below
exists in the repository; the two that don't are in [Not built yet](#not-built-yet)
and are drawn dashed so nobody mistakes a plan for a component.

**Two corrections to the usual description of this app.** There is **no React** —
the renderer is plain ES modules under `public/`, no framework, no build step.
And there is **no MCP layer** — tools are defined in-process against a local
contract registry (`lib/tool-contracts.mjs`). Both would be additions, not
descriptions.

---

## 1. System map

The load-bearing idea: the renderer holds no state that matters and no
credentials. It draws, and it asks a loopback HTTP server on `127.0.0.1` for
everything else. Every domain service sits behind that boundary, on the Node
side, where the database and the keys are.

```mermaid
flowchart TB
    subgraph shell["Electron shell — desktop only"]
        main["Main process<br/>electron/main.mjs"]
        preload["Preload bridge<br/>contextIsolation on<br/>nodeIntegration off"]
        voice["Voice service<br/>Piper TTS · Whisper STT"]
        vaulthost["Vault + project host<br/>native folder pickers"]
        safestore["safeStorage<br/>OS keychain"]
    end

    subgraph renderer["Renderer — vanilla ES modules, no framework"]
        app["app.js<br/>chat, projects, settings"]
        physicsui["physics.js<br/>canvas renderer"]
        labui["lab.js<br/>lab display"]
        demoui["demo.js"]
    end

    subgraph server["Loopback HTTP server — server.mjs on 127.0.0.1"]
        router["Request router<br/>+ auth session"]
        scope["Profile scope<br/>AsyncLocalStorage + Proxy"]
        chat["Chat turn loop<br/>12 rounds · 4 tools at a time"]
        routes["Feature routes<br/>physics · sandbox · goals · hud"]
    end

    subgraph services["Domain services — lib/"]
        intel["AI router<br/>intelligence.mjs"]
        providers["Provider service<br/>providers.mjs"]
        tools["Tool registry<br/>tools.mjs · 39 tools"]
        contracts["Risk ladder<br/>tool-contracts.mjs"]
        agent["Agent runtime<br/>agent-runtime.mjs"]
        obsidian["Obsidian service<br/>obsidian.mjs"]
        physics["Physics engine<br/>physics.mjs · headless Matter.js"]
        memory["Memory + projects<br/>memory.mjs · projects.mjs"]
    end

    subgraph stores["State"]
        db[("Per-profile SQLite<br/>WAL · 78 tables<br/>ordered migration ledger")]
        keys[("Encrypted credentials<br/>secrets.mjs")]
        notes[("Obsidian vault<br/>your folder on disk")]
    end

    subgraph models["Models"]
        ollama["Ollama<br/>localhost:11434"]
        cloud["OpenAI · Anthropic · Gemini<br/>host-allowlisted HTTPS"]
    end

    renderer -->|"fetch, same-origin only"| router
    app -.->|"IPC, narrow surface"| preload
    preload --> main
    main --> voice
    main --> vaulthost
    main --> safestore
    safestore -.-> keys

    router --> scope
    scope --> chat
    scope --> routes
    chat --> intel
    chat --> tools
    chat --> agent
    routes --> physics
    routes --> market

    intel -->|"picks provider + model"| providers
    providers -->|"streams tokens"| ollama
    providers -->|"streams tokens"| cloud
    providers --> keys

    tools --> contracts
    tools --> obsidian
    tools --> physics
    tools --> memory
    obsidian --> notes

    services --> db
```

**Why the physics engine is on the server side and not in the canvas.** So that
"what is in the scene?" has one answer. If the simulation lived in the page, the
question would really mean "what does some open tab currently believe", and
asking with no window open would answer "nothing". The engine runs headless, the
model reads the same bodies the solver just moved, and the canvas receives
already-solved polygons to draw. A fixed timestep makes the same scene run twice
give identical results — the difference between an experiment and an animation.

---

## 2. Data flow — one chat turn

This is the path a single message takes. The loop is the part worth reading
closely: the model can come back asking for tools up to twelve times, and each
round runs at most four of them.

```mermaid
sequenceDiagram
    participant U as You
    participant R as Renderer
    participant S as server.mjs
    participant I as AI router
    participant P as Provider
    participant T as Tool registry
    participant D as SQLite

    U->>R: type a message
    R->>S: POST /api/conversations/:id/chat
    S->>D: persist user message
    S->>S: enter profile scope
    S->>I: analyzeTask + selectAutoModel
    I->>D: read model preferences
    I-->>S: provider + model + reason
    S->>D: record routing decision

    loop up to 12 rounds
        S->>P: stream completion, tools attached
        P-->>S: tokens + tool calls
        S-->>R: stream deltas as they arrive

        alt model asked for tools
            S->>S: take first 4, defer the rest by name
            par up to 4 concurrently
                S->>T: execute call
                T-->>S: result
            end
            S->>D: write tool messages in the order asked
            S-->>R: tool_result events
        else model answered
            S->>D: mark complete
            S-->>R: complete
        end
    end

    Note over S,P: the last round is asked with no tools,<br/>so a turn always ends in an answer
```

Three details that are easy to get wrong and are deliberate here:

- **Results are recorded in the order the model asked**, not the order they
  finished. Concurrency must not reorder the transcript.
- **Deferred calls are named back to the model** — "these were not run and have
  no result: …" — rather than dropped. Dropping them silently is how a model ends
  up describing ten objects when only six exist.
- **The final round is asked with no tools at all**, so running out of rounds
  produces an answer instead of an error about a limit the user never saw.

---

## 3. Permissions — what a tool call has to pass

Every tool declares a risk class. Three tiers run on their own; one raises an
approval and suspends the run; three are compiled out entirely and refuse to
even register.

```mermaid
flowchart LR
    call["Model asks<br/>for a tool"] --> known{"tool known<br/>and enabled?"}
    known -->|no| refuse["refuse<br/>UNKNOWN_TOOL"]
    known -->|yes| valid{"arguments match<br/>the schema?"}
    valid -->|no| refuse2["refuse<br/>INVALID_ARGUMENT"]
    valid -->|yes| tier{"risk class"}

    tier -->|"read"| auto["run now"]
    tier -->|"network-read"| auto
    tier -->|"sandbox"| auto
    tier -->|"approval-write"| pause["write a proposal<br/>suspend the run<br/>wait for a human"]
    tier -->|"sensitive-write<br/>command<br/>destructive"| dead["disabled at load<br/>cannot be registered"]

    auto --> budget{"budget left?"}
    pause -->|"approved"| budget
    pause -->|"rejected"| stop["run stays paused"]
    budget -->|no| exceeded["RUN_BUDGET_EXCEEDED"]
    budget -->|yes| exec["execute<br/>timeout + abort signal"]
    exec --> audit[("audit_events<br/>tool_runs")]
```

The tiers, from `lib/tool-contracts.mjs`:

| Risk class | Runs automatically | Effect | Enabled |
|---|---|---|---|
| `read` | yes | local read | yes |
| `network-read` | yes | bounded network read | yes |
| `sandbox` | yes | writes inside a disposable sandbox | yes |
| `approval-write` | **no** | proposal only — a diff a human applies | yes |
| `sensitive-write` | no | real write | **no** |
| `command` | no | shell command | **no** |
| `destructive` | no | destructive | **no** |

`sandbox` is automatic on purpose: the point of simulating is that a model can
try, fail and retry without asking. The approval belongs to promoting the
result, not to the attempt.

An Obsidian edit never writes your note. It writes a *proposal* — a reviewable
diff — and the vault only changes when you approve it. That is what
`approval-write` means in practice.

---

## 4. Profile isolation

Every account gets its own database file. The mechanism is worth knowing because
it is invisible: services are not passed around as arguments, they are resolved
per request.

```mermaid
flowchart LR
    req["HTTP request"] --> auth["session → profile id"]
    auth --> als["AsyncLocalStorage<br/>profileScope.run"]
    als --> handler["route handler"]
    handler -->|"database.query(…)"| proxy["Proxy"]
    proxy -->|"reads current scope"| resolve["resolve for this profile"]
    resolve --> dbA[("profile A<br/>evolv.db")]
    resolve -.-> dbB[("profile B<br/>evolv.db")]

    style dbB stroke-dasharray: 4 4
```

`database`, `toolRegistry`, `providerService` and `vaultService` are all `Proxy`
objects in `server.mjs`. Touching a property resolves it against whichever
profile owns the in-flight request. A handler cannot reach another profile's data
by accident, because it never holds a handle to one.

---

## 5. Component breakdown

| Component | Where | What it owns |
|---|---|---|
| Electron main | `electron/main.mjs` | window, permissions, IPC bridges, update service |
| Preload bridge | `electron/preload.cjs` | the only IPC surface the renderer sees — voice, vault picker, project picker, quit/update |
| Voice | `electron/voice-service.mjs` | Piper TTS and Whisper STT, both bundled, both offline |
| Renderer | `public/*.js` | chat UI, physics canvas, lab display, agent workspace, demo — vanilla ES modules |
| HTTP server | `server.mjs` | routing, auth sessions, the chat turn loop, profile scoping |
| AI router | `lib/intelligence.mjs` | reads the task, scores candidate models, picks one, records why |
| Providers | `lib/providers.mjs` | Ollama plus OpenAI, Anthropic, Gemini; capability detection; streaming |
| Tool registry | `lib/tools.mjs` | 39 tools, validation, timeouts, audit records |
| Risk ladder | `lib/tool-contracts.mjs` | the six-tier permission model above |
| Tool batching | `lib/tool-batching.mjs` | groups a round's calls into concurrent batches of four |
| Agent runtime | `lib/agent-runtime.mjs` | runs, steps, budgets, checkpoints, pause/resume, approvals |
| Goal runner | `lib/goal-runner.mjs`, `lib/goal-contracts.mjs` | plan → verify → evidence for multi-step answers |
| Escalation | `lib/goal-escalation.mjs` | decides, without calling a model, whether a message is work rather than a question |
| Specialists | `lib/agents.mjs` | the roles a plan step can be executed as, and what each may reach |
| Obsidian | `lib/obsidian.mjs`, `lib/obsidian-vault.mjs` | indexes your vault, proposes edits as diffs |
| Physics | `lib/physics.mjs`, `server/physics-routes.mjs` | headless Matter.js, perception, scene save/load |
| Sandbox | `lib/sandbox.mjs`, `server/sandbox-routes.mjs` | disposable workspace for simulated edits |
| Memory | `lib/memory.mjs` | memory nodes and edges, continual memory proposals |
| Projects | `lib/projects.mjs` | project files, tasks, knowledge chunks, grants |
| Evolution | `lib/evolution.mjs` | run evaluation, benchmark cases, failure patterns |
| Secrets | `lib/secrets.mjs` | API keys, encrypted via OS keychain on desktop |
| Schema | `lib/schema.mjs` | 78 tables, ordered migration ledger with SHA-256 checksums |

### There is no plugin system

There was one — signed `.evolvpack` files, a catalog, publisher trust, a
permission review dialog — and it was removed in 0.6.5 along with the storefront
that browsed it. It existed so that somebody could extend Evolv, and nobody was
going to. The schema migrations that created its tables are still in place,
because the ledger has to stay replayable; the tables are simply unused.

Tools are defined in-process against `lib/tool-contracts.mjs`, and the risk
ladder above is the whole permission model.

## Not built yet

Drawn dashed because they are proposals, not code.

```mermaid
flowchart TB
    subgraph now["Today"]
        reg["Tool registry<br/>39 in-process tools"]
        run["Agent runtime<br/>one run, sequential steps"]
    end

    subgraph later["Proposed"]
        mcp["MCP layer<br/>external tool servers"]
        multi["Multi-agent<br/>supervisor + workers"]
    end

    reg -.->|"same contract,<br/>remote transport"| mcp
    run -.->|"many runs,<br/>shared budget + evidence"| multi

    style mcp stroke-dasharray: 5 5
    style multi stroke-dasharray: 5 5
    style later stroke-dasharray: 5 5
```

**An MCP layer** would be a second source of tools behind the existing contract:
`defineToolContract` already normalizes name, schema, risk class and timeout, so
an MCP server's tools could be registered through the same door and inherit the
same risk ladder. The work is transport and trust — deciding what risk class a
remote tool may claim, and what happens when the server disappears mid-call.

**A multi-agent framework** has more of its groundwork in place than the tool
layer does. `agent-runtime.mjs` already models runs, steps, budgets, checkpoints
and evidence, and a run can pause and resume. What is missing is more than one
run cooperating: a supervisor that decomposes a goal, workers that hold separate
contexts, and a budget shared across them rather than per-run. The pause/resume
checkpointing is the part usually retrofitted painfully, and it already exists.

---

*Diagrams generated from the code at the commit that added this file. If a box
here stops matching `lib/`, the diagram is wrong, not the code.*
