# Evolv Personal 0.6.0 Release Notes

Evolv 0.6.0 adds a durable, visible Goal Runner to the private desktop build. The published itch.io release is unchanged.

## What is new

- A dedicated **Agent** workspace for goals, success criteria, project and model selection, editable plans, live steps, evidence, retries, approvals, artifacts, and verification.
- Validated plans of no more than 12 steps. Unknown tools, dependency cycles, escaping paths, excess budgets, and missing verification gates are rejected before execution.
- Safe local reads run automatically. Network research, workspace changes, engineering checks, and user-note changes still pause for individual approval.
- Immutable step-attempt history, durable checkpoints, restart recovery, cancellation, retry, replanning, and honest partial/failed outcomes.
- Typed NDJSON events for plans, routes, fallbacks, steps, evidence, approvals, verification, errors, and completion.
- Deterministic, conflict-safe Obsidian run journals under the connected project's managed `Runs` folder.
- Goal contracts, orchestration, route handling, and the Agent renderer are now separate modules, beginning the monolith cleanup without changing the established visual design.

## Safety behavior

Approving a plan does not authorize arbitrary commands or general filesystem access. It authorizes the listed plan and deterministic append-only run journal. Every network request, file effect, check, or user-note change still returns to a separate approval boundary. No model can increase budgets, add permissions, select an arbitrary vault path, or mark a goal complete without verification evidence.
