# Evolv Stage 2 - Durable Agent Runtime

## Delivered scope

Stage 2 adds a real persisted execution envelope around Evolv's existing chat and safe-tool loop. It does not pretend that the current one-step chat executor is already a general multi-project autonomous planner. That broader planning layer belongs to the later Projects and Agents stages.

Each persisted chat response now creates or resumes an agent run with:

- one versioned plan and one leased chat step;
- an explicit state machine;
- ordered run events and transactional checkpoints;
- limits for steps, runtime, tool calls, retries, estimated tokens, and estimated cost units;
- before/after evidence for model and tool effects;
- durable pause, resume, cancellation, completion, failure, and restart recovery;
- duplicate active-run prevention per conversation;
- approval-aware continuation using the same run and step.

## State machine

Supported states are `idle`, `planning`, `waiting_for_approval`, `executing`, `observing`, `evaluating`, `revising`, `paused`, `completed`, `failed`, and `cancelled`.

Every state change is checked against an allowlist. Terminal runs cannot resume. Startup recovery pauses abandoned active runs and releases their leases; it never marks an unfinished effect successful.

## Persistence

Schema version 6 adds:

- `agent_runs`
- `run_plans`
- `run_steps`
- `run_events`
- `run_checkpoints`
- `run_budgets`

One partial unique index prevents a conversation from owning two active runs. Profile databases keep all run data account-isolated. SQLite backups include run state automatically.

## HTTP and streaming interfaces

- `GET /api/runs`
- `GET /api/runs/:id`
- `POST /api/runs/:id/pause`
- `POST /api/runs/:id/resume`
- `POST /api/runs/:id/cancel`

Chat NDJSON now includes `run` events. Existing clients may ignore them; the current renderer displays a compact run card with state, budgets, and available controls.

## Approval behavior

An approval-required tool stops the agent step and moves the run to `waiting_for_approval`. The application does not ask the model to continue while the effect is unresolved. An approved or reviewable rejected decision releases the run to `paused`, after which the UI resumes the same run. A decision that has no continuation terminates the run instead of leaving it stuck.

## Honest accounting limits

Providers do not yet expose normalized token and price accounting in Evolv. Stage 2 therefore labels token values as estimates based on generated character count and uses one coarse cloud cost unit per completed cloud response. Exact provider usage and currency accounting remain Stage 1 ModelGateway work and must not be presented as billed cost.

## Verification

Automated coverage includes legal transitions, invalid transitions, duplicate prevention, leases, checkpoints, budget exhaustion, pause/resume, cancellation, approval continuation, startup recovery, streaming integration, and existing compatibility tests.
