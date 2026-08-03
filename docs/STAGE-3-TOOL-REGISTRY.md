# Evolv Stage 3 - Typed Tool Registry and Unified Approvals

## Delivered scope

Stage 3 gives Evolv's built-in tools one versioned runtime contract and routes reviewable effects through one durable approval envelope. Existing permissions were not expanded. The specialized engineering, Obsidian, recipe, and macro validators remain the final authority for their domains.

## Tool contract

Every built-in tool now declares:

- contract version;
- JSON input schema and bounded JSON-serializable output schema;
- risk class and shared risk policy;
- permission, timeout, output limit, validator, and executor;
- a cooperative `AbortSignal` supplied to its executor.

The enabled risk classes are `read`, `network-read`, and `approval-write`. The policy vocabulary also reserves `sensitive-write`, `command`, and `destructive`, but definitions in those classes are rejected because those general capabilities are disabled. Existing engineering checks remain narrowly allowlisted proposals rather than becoming a general command tool.

The output schema is intentionally generic in this increment. Runtime output remains bounded and JSON serializable, but rich per-tool domain output schemas are future refinement rather than something this release claims to have.

## Dry runs and cancellation

`POST /api/tools/:name/dry-run` validates a tool request and returns its contract, risk, approval policy, effect category, and timeout without invoking the handler or creating a tool run. Generated macros receive a structural dry run that lists their ordered steps and risks; no step executes.

Tool timeouts and caller cancellation now use abort signals instead of a detached `Promise.race`. Network reads receive the signal in `fetch`, workspace file reads use abortable filesystem calls, directory/search loops check the signal between operations, and macros forward the same signal to each step. Tests prove that cancellation reaches the underlying blocked network operation and records `CANCELLED` rather than reporting false completion.

## Unified approval envelope

Schema version 7 adds `approval_requests`. An envelope records:

- kind, risk, resource, conversation, tool run, and agent run;
- summary and bounded before/after evidence;
- pending, approved, rejected, expired, failed, or cancelled state;
- authorization time separately from execution time;
- execution result or safe error;
- delegation to a specialized inner approval when a macro pauses on a write.

Engineering actions, Obsidian changes, generated recipe installation, explicit macro installation, and approval-gated macro effects now create this shared record. A macro approval resolves to its inner engineering or Obsidian validator, so composition never bypasses the original boundary. The existing `POST /api/tool-runs/:id/decision` route dispatches through the envelope and resumes the durable Stage 2 agent run only after the specialized decision completes.

Read-only inspection endpoints are:

- `GET /api/approvals`
- `GET /api/approvals/:id`

These routes remain profile-scoped behind Evolv authentication. Approval records contain no credentials or provider secrets.

## Deliberate limits

- There is no arbitrary shell, general command, package installation, silent file write, permanent Obsidian delete, permission expansion, or self-modifying code.
- Dry run validates declared inputs and policy; it does not predict an external service response or claim a write will succeed.
- Approval and execution are separate. An approved effect receives `executed_at` only after the specialized operation succeeds. Failures are recorded as failures rather than success.
- The current HTTP approval decision remains keyed by tool-run ID for renderer compatibility. The shared envelope is the durable domain record underneath it.

## Verification

Coverage includes contract validation, disabled risk classes, dry-run non-execution, malformed inputs, underlying cancellation, timeout signaling, approval idempotency, authorization-versus-execution evidence, delegated macro approvals, authenticated approval inspection, existing direct engineering/Obsidian decisions, Stage 2 continuation, and the complete compatibility suite.
