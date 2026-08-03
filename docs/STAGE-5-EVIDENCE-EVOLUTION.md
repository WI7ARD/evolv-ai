# Evolv Stage 5 - Evidence-Based Evolution

## Delivered scope

Stage 5 adds a profile-isolated evidence and strategy system on top of the persisted Stage 3 agent runtime. SQLite schema version 9 stores run evaluations, recurring failure patterns, fixed benchmark cases, strategy candidates, benchmark runs/results, and explicit strategy decisions.

Ordinary chat does **not** trigger an extra model judge. Evolv records only facts already produced by the run: terminal state, persisted output, tool calls and failures, citation presence, elapsed time, estimated token usage, and estimated cost units. Quality, instruction following, and factuality remain `null` until the user gives explicit feedback. The dashboard labels this distinction.

## Feedback and failure patterns

An explicit positive or negative rating updates the associated run evaluation. Negative feedback is categorized locally into a bounded failure class and deduplicated by a stable fingerprint. Repeated feedback increments the same pattern and retains bounded run evidence. A pattern never changes active behavior by itself.

The Strategy Lab can link selected failure patterns to a candidate prompt-guidance strategy. Candidate text is bounded and rejects instructions that attempt to disable safety or approval, expand permissions, reveal credentials, enable shell commands, modify source code, or silently authorize writes.

## Deterministic benchmark gate

Every candidate is compared against the currently active strategy on five fixed fixtures:

1. document citation grounding;
2. code defect detection;
3. ordered planning with verification and rollback;
4. a six-call tool limit with explicit write approval;
5. honest recovery after a tool failure.

Each fixture runs once with the active baseline and once with the candidate, for ten model calls total. Outputs are scored by deterministic checks stored with the fixture; there is no model-as-judge call. Evolv recommends a candidate only when its mean score improves and it introduces no critical regression. This is a small regression gate, not proof of general intelligence or open-world factual accuracy.

The user must choose a specific provider and model before running the benchmark. The UI warns that a cloud selection may create provider charges. Stored cost units are estimates and are not a replacement for provider billing data.

## Promotion and rollback

- Candidates are inactive after creation and after benchmarking.
- Approval is rejected unless the selected candidate has a completed, recommending benchmark.
- Activation requires a separate explicit user decision.
- The prior active strategy is retained as superseded.
- Rollback restores that prior strategy through another explicit user action.
- The active guidance is appended below Evolv's base system prompt and is explicitly unable to change tools, permissions, credential handling, approval rules, or source code.

## Interfaces

- `GET /api/evolution`
- `GET /api/evolution/evaluations`
- `GET /api/evolution/failures`
- `GET /api/evolution/benchmarks`
- `POST /api/evolution/strategies`
- `GET /api/evolution/strategies/:id`
- `POST /api/evolution/strategies/:id/benchmark`
- `POST /api/evolution/strategies/:id/decision`
- `POST /api/evolution/rollback`

The Personal Intelligence screen now includes factual run evidence, recurring failure patterns, candidate creation, the ten-call benchmark, explicit approval/rejection, and rollback.

## Security and privacy boundaries

- All records live inside the signed-in profile database.
- Ordinary run evaluation is local and creates no provider call.
- Benchmark calls use only the provider/model explicitly selected by the user.
- API keys, authentication records, cookies, CSRF tokens, vault paths, and secret values are never copied into evaluation evidence.
- Model output cannot grant tools, authorize effects, install packages, expose secrets, modify source, or activate a strategy.
- No source-code self-modification was added.

## Verification

The automated suite contains 168 passing tests. New coverage verifies factual local metrics, absence of hidden judge calls, explicit-feedback scoring, recurring-pattern deduplication, unsafe-strategy rejection, all five deterministic fixtures, promotion gating, critical-regression blocking, rollback, the authenticated API, the rendered controls, and evidence creation after a real persisted stream. Existing authentication, providers, streaming, projects, Obsidian, tools, approvals, Marketplace, voice, Linux, and Windows release tests also pass.

