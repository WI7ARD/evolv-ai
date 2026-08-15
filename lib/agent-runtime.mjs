import crypto from "node:crypto";
import { GOAL_BUDGET_LIMITS, normalizeGoalBudgets, validateGoalPlan } from "./goal-contracts.mjs";

export const RUN_STATES = Object.freeze([
  "idle", "planning", "waiting_for_approval", "executing", "observing",
  "evaluating", "revising", "paused", "completed", "failed", "cancelled"
]);

export const TERMINAL_RUN_STATES = Object.freeze(["completed", "failed", "cancelled"]);

const TRANSITIONS = Object.freeze({
  idle: new Set(["planning", "paused", "failed", "cancelled"]),
  planning: new Set(["waiting_for_approval", "executing", "paused", "failed", "cancelled"]),
  waiting_for_approval: new Set(["executing", "paused", "failed", "cancelled"]),
  executing: new Set(["waiting_for_approval", "observing", "paused", "failed", "cancelled"]),
  observing: new Set(["evaluating", "revising", "paused", "failed", "cancelled"]),
  evaluating: new Set(["revising", "completed", "paused", "failed", "cancelled"]),
  revising: new Set(["planning", "executing", "paused", "failed", "cancelled"]),
  paused: new Set(["planning", "waiting_for_approval", "executing", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
});

const DEFAULT_BUDGETS = Object.freeze({
  maxSteps: 12,
  maxRuntimeMs: 10 * 60 * 1000,
  maxToolCalls: 100,
  maxRetries: 2,
  maxTokens: 256 * 1024,
  maxCostUnits: 10
});

function timestamp() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeBudgets(input = {}) {
  return {
    maxSteps: boundedInteger(input.maxSteps, DEFAULT_BUDGETS.maxSteps, 1, 100),
    maxRuntimeMs: boundedInteger(input.maxRuntimeMs, DEFAULT_BUDGETS.maxRuntimeMs, 5_000, 24 * 60 * 60 * 1000),
    maxToolCalls: boundedInteger(input.maxToolCalls, DEFAULT_BUDGETS.maxToolCalls, 0, 100),
    maxRetries: boundedInteger(input.maxRetries, DEFAULT_BUDGETS.maxRetries, 0, 20),
    maxTokens: boundedInteger(input.maxTokens, DEFAULT_BUDGETS.maxTokens, 256, 1_000_000),
    maxCostUnits: boundedInteger(input.maxCostUnits, DEFAULT_BUDGETS.maxCostUnits, 0, 1_000_000)
  };
}

function runtimeError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export class AgentRuntime {
  constructor(database, { leaseMs = 30_000, clock = () => Date.now() } = {}) {
    this.database = database;
    this.db = database.raw;
    this.leaseMs = boundedInteger(leaseMs, 30_000, 1_000, 10 * 60 * 1000);
    this.clock = clock;
  }

  #appendEvent(runId, stepId, type, payload = {}, createdAt = timestamp()) {
    const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM run_events WHERE run_id = ?").get(runId)?.value || 1);
    this.db.prepare(`
      INSERT INTO run_events(id, run_id, step_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), runId, stepId || null, sequence, String(type).slice(0, 100), JSON.stringify(payload || {}), createdAt);
    return sequence;
  }

  #checkpoint(runId, stepId, eventSequence, state, data = {}, createdAt = timestamp()) {
    this.db.prepare(`
      INSERT INTO run_checkpoints(id, run_id, step_id, event_sequence, state, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), runId, stepId || null, eventSequence, state, JSON.stringify(data || {}), createdAt);
  }

  #transition(runId, nextState, { reason = "", stepId = null, payload = {} } = {}) {
    if (!RUN_STATES.includes(nextState)) throw runtimeError("Unknown agent run state.", "RUN_STATE_INVALID", 400);
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(runId);
      if (!current) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
      if (current.state === nextState) return this.get(runId);
      if (!TRANSITIONS[current.state]?.has(nextState)) {
        throw runtimeError(`Agent run cannot move from ${current.state} to ${nextState}.`, "RUN_TRANSITION_INVALID");
      }
      const changedAt = timestamp();
      const beforeSequence = this.#appendEvent(runId, stepId, "state.transition.requested", {
        from: current.state, to: nextState, reason, ...payload
      }, changedAt);
      this.#checkpoint(runId, stepId, beforeSequence, current.state, { phase: "before-transition", requestedState: nextState }, changedAt);
      const terminal = TERMINAL_RUN_STATES.includes(nextState);
      this.db.prepare(`
        UPDATE agent_runs SET state = ?, updated_at = ?,
          started_at = CASE WHEN started_at IS NULL AND ? IN ('planning','executing') THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          error = CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE error END
        WHERE id = ?
      `).run(nextState, changedAt, nextState, changedAt, terminal ? 1 : 0, changedAt, nextState, String(reason || "").slice(0, 2000), runId);
      const afterSequence = this.#appendEvent(runId, stepId, "state.transition.completed", {
        from: current.state, to: nextState, reason
      }, changedAt);
      this.#checkpoint(runId, stepId, afterSequence, nextState, { phase: "after-transition" }, changedAt);
      return this.get(runId);
    })();
  }

  createChatRun({ conversationId, objective, providerId = "", modelId = "", request = {}, budgets = {} }) {
    const runId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const createdAt = timestamp();
    const limits = normalizeBudgets(budgets);
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO agent_runs(id, conversation_id, objective, state, executor, provider_id, model_id,
            request_json, resume_state, created_at, updated_at)
          VALUES (?, ?, ?, 'idle', 'persisted-chat-v1', ?, ?, ?, 'executing', ?, ?)
        `).run(runId, conversationId, String(objective || "").slice(0, 100_000), providerId, modelId,
          JSON.stringify(request || {}), createdAt, createdAt);
        this.db.prepare(`
          INSERT INTO run_budgets(run_id, max_steps, max_runtime_ms, max_tool_calls, max_retries,
            max_tokens, max_cost_units, started_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, limits.maxSteps, limits.maxRuntimeMs, limits.maxToolCalls, limits.maxRetries,
          limits.maxTokens, limits.maxCostUnits, createdAt, createdAt);
        this.db.prepare(`
          INSERT INTO run_plans(id, run_id, revision, status, summary, created_at)
          VALUES (?, ?, 1, 'active', 'Generate and verify one persisted assistant response using the existing safe chat/tool loop.', ?)
        `).run(planId, runId, createdAt);
        this.db.prepare(`
          INSERT INTO run_steps(id, run_id, plan_id, position, title, description, kind, state, max_retries, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'Produce assistant response', 'Route the request, call approved tools when needed, persist the response, and verify completion.',
            'chat', 'pending', ?, ?, ?)
        `).run(stepId, runId, planId, limits.maxRetries, createdAt, createdAt);
        const sequence = this.#appendEvent(runId, null, "run.created", { executor: "persisted-chat-v1", budgets: limits }, createdAt);
        this.#checkpoint(runId, null, sequence, "idle", { planRevision: 1 }, createdAt);
      })();
    } catch (error) {
      if (String(error.code || "").startsWith("SQLITE_CONSTRAINT")) {
        throw runtimeError("This conversation already has an active agent run.", "RUN_ALREADY_ACTIVE");
      }
      throw error;
    }
    this.#transition(runId, "planning", { reason: "chat request accepted" });
    this.#transition(runId, "executing", { reason: "single-step chat plan created", stepId });
    this.leaseStep(runId, stepId);
    return this.get(runId);
  }

  createGoalRun({ conversationId, projectId, packId = "", objective, successCriteria = [], providerId = "", modelId = "", request = {}, budgets = {}, plan, availableTools = [] }) {
    const runId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const createdAt = timestamp();
    const limits = normalizeGoalBudgets(budgets);
    const validated = validateGoalPlan(plan, { availableTools, budgets: limits });
    const planId = crypto.randomUUID();
    const criteria = Array.isArray(successCriteria) ? successCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : [];
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO agent_runs(id,conversation_id,objective,state,executor,provider_id,model_id,request_json,resume_state,created_at,updated_at)
        VALUES(?,?,?,'idle','goal-runner-v1',?,?,?,'planning',?,?)`).run(
        runId, conversationId, String(objective || "").slice(0, 100_000), providerId, modelId,
        JSON.stringify({ ...request, projectId, packId, successCriteria: criteria }), createdAt, createdAt
      );
      this.db.prepare(`INSERT INTO run_budgets(run_id,max_steps,max_runtime_ms,max_tool_calls,max_retries,max_tokens,max_cost_units,started_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(runId, limits.maxSteps, limits.maxRuntimeMs, limits.maxToolCalls, limits.maxRetries,
        limits.maxTokens, limits.maxCostUnits, createdAt, createdAt);
      this.db.prepare(`INSERT INTO agent_goals(id,run_id,project_id,pack_id,success_criteria_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'planned',?,?)`).run(goalId, runId, projectId || null, packId || null, JSON.stringify(criteria), createdAt, createdAt);
      this.#insertPlan(runId, planId, 1, validated, limits.maxRetries, createdAt);
      const sequence = this.#appendEvent(runId, null, "plan.proposed", { revision: 1, planId, summary: validated.summary, steps: validated.steps }, createdAt);
      this.#checkpoint(runId, null, sequence, "idle", { goalId, planRevision: 1 }, createdAt);
    })();
    this.#transition(runId, "planning", { reason: "goal accepted for plan review" });
    this.#transition(runId, "waiting_for_approval", { reason: "plan requires explicit approval" });
    return this.get(runId);
  }

  #insertPlan(runId, planId, revision, plan, maxRetries, createdAt = timestamp()) {
    this.db.prepare(`INSERT INTO run_plans(id,run_id,revision,status,summary,created_at) VALUES(?,?,?,'active',?,?)`)
      .run(planId, runId, revision, plan.summary, createdAt);
    this.db.prepare(`INSERT INTO run_plan_details(plan_id,plan_json) VALUES(?,?)`).run(planId, JSON.stringify(plan));
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      const stepId = crypto.randomUUID();
      this.db.prepare(`INSERT INTO run_steps(id,run_id,plan_id,position,title,description,kind,state,max_retries,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(stepId, runId, planId, index + 1, step.title, step.description, step.type, maxRetries, createdAt, createdAt);
      this.db.prepare(`INSERT INTO run_step_details(step_id,external_id,dependencies_json,inputs_json,expected_evidence,verification_criteria,approval_policy,tool_name)
        VALUES(?,?,?,?,?,?,?,?)`).run(stepId, step.id, JSON.stringify(step.dependencies), JSON.stringify(step.inputs), step.expectedEvidence,
        step.verificationCriteria, step.approvalPolicy, step.tool || "");
    }
  }

  reviseGoalPlan(runId, plan, { availableTools = [], roster = undefined } = {}) {
    const run = this.get(runId);
    if (!run || run.executor !== "goal-runner-v1") throw runtimeError("Goal run not found.", "RUN_NOT_FOUND", 404);
    if (TERMINAL_RUN_STATES.includes(run.state) || run.state === "executing") throw runtimeError("Pause this goal before revising its plan.", "RUN_PLAN_NOT_EDITABLE");
    const validated = validateGoalPlan(plan, { availableTools, budgets: run.budgets || GOAL_BUDGET_LIMITS, roster });
    const revision = Math.max(0, ...run.plans.map((item) => Number(item.revision))) + 1;
    const planId = crypto.randomUUID();
    const createdAt = timestamp();
    this.db.transaction(() => {
      this.db.prepare("UPDATE run_plans SET status='superseded' WHERE run_id=? AND status='active'").run(runId);
      this.#insertPlan(runId, planId, revision, validated, run.budgets.maxRetries, createdAt);
      this.db.prepare("UPDATE agent_goals SET status='planned',updated_at=? WHERE run_id=?").run(createdAt, runId);
      this.#appendEvent(runId, null, "plan.revised", { revision, planId, summary: validated.summary, steps: validated.steps }, createdAt);
    })();
    const current = this.get(runId);
    if (current.state === "waiting_for_approval") {
      this.#transition(runId, "paused", { reason: "previous plan replaced" });
      this.#transition(runId, "planning", { reason: "revised plan validated" });
    } else if (current.state === "paused") this.#transition(runId, "planning", { reason: "revised plan validated" });
    if (this.get(runId).state === "planning") this.#transition(runId, "waiting_for_approval", { reason: "revised plan requires approval" });
    return this.get(runId);
  }

  approveGoalPlan(runId) {
    const run = this.get(runId);
    if (!run || run.executor !== "goal-runner-v1") throw runtimeError("Goal run not found.", "RUN_NOT_FOUND", 404);
    if (run.state !== "waiting_for_approval") throw runtimeError("This plan is not awaiting approval.", "RUN_PLAN_NOT_WAITING");
    const plan = run.plans.find((item) => item.status === "active");
    const detail = this.db.prepare("SELECT plan_json AS planJson FROM run_plan_details WHERE plan_id=?").get(plan.id);
    const hash = crypto.createHash("sha256").update(detail.planJson).digest("hex");
    const approvalId = crypto.randomUUID();
    const changedAt = timestamp();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO run_plan_approvals(id,run_id,plan_id,revision,decision,plan_hash,created_at) VALUES(?,?,?,?, 'approved',?,?)`)
        .run(approvalId, runId, plan.id, plan.revision, hash, changedAt);
      this.db.prepare("UPDATE run_plan_details SET approved_at=?,approval_record_id=? WHERE plan_id=?").run(changedAt, approvalId, plan.id);
      this.db.prepare("UPDATE agent_goals SET status='approved',updated_at=? WHERE run_id=?").run(changedAt, runId);
      this.db.prepare("UPDATE agent_runs SET resume_state='executing' WHERE id=?").run(runId);
      this.#appendEvent(runId, null, "plan.approved", { planId: plan.id, revision: plan.revision, approvalId, hash }, changedAt);
    })();
    return this.#transition(runId, "paused", { reason: "plan approved; ready to start" });
  }

  startGoal(runId) {
    const run = this.get(runId);
    if (!run || run.executor !== "goal-runner-v1") throw runtimeError("Goal run not found.", "RUN_NOT_FOUND", 404);
    const approved = this.db.prepare(`SELECT 1 FROM run_plan_approvals a JOIN run_plans p ON p.id=a.plan_id
      WHERE a.run_id=? AND a.decision='approved' AND p.status='active' LIMIT 1`).get(runId);
    if (!approved) throw runtimeError("Approve the current plan before starting.", "RUN_PLAN_APPROVAL_REQUIRED");
    if (run.state === "paused") this.#transition(runId, "executing", { reason: "goal started by user" });
    else if (run.state !== "executing") throw runtimeError("This goal cannot be started from its current state.", "RUN_NOT_EXECUTABLE");
    this.db.prepare("UPDATE agent_goals SET status='running',updated_at=? WHERE run_id=?").run(timestamp(), runId);
    const step = this.nextRunnableStep(runId);
    return step ? this.leaseStep(runId, step.id) : this.get(runId);
  }

  nextRunnableStep(runId) {
    const run = this.get(runId);
    const completed = new Set(run.steps.filter((step) => step.state === "completed").map((step) => step.externalId));
    return run.steps.find((step) => step.state === "pending" && step.dependencies.every((id) => completed.has(id))) || null;
  }

  addEvent(runId, stepId, type, payload = {}) {
    const sequence = this.#appendEvent(runId, stepId, type, payload);
    const state = this.db.prepare("SELECT state FROM agent_runs WHERE id=?").get(runId)?.state || "idle";
    this.#checkpoint(runId, stepId, sequence, state, { type, ...payload });
    return sequence;
  }

  addEvidence(runId, stepId, { kind = "result", title = "Evidence", payload = {}, citation = "" } = {}) {
    const id = crypto.randomUUID();
    const createdAt = timestamp();
    this.db.prepare(`INSERT INTO run_evidence(id,run_id,step_id,kind,title,payload_json,citation,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, runId, stepId || null, String(kind).slice(0, 80), String(title).slice(0, 300), JSON.stringify(payload || {}), String(citation).slice(0, 2000), createdAt);
    this.#appendEvent(runId, stepId, "evidence.recorded", { id, kind, title, citation }, createdAt);
    return id;
  }

  addArtifact(runId, stepId, artifact = {}) {
    const id = crypto.randomUUID();
    const createdAt = timestamp();
    this.db.prepare(`INSERT INTO run_artifacts(id,run_id,step_id,project_artifact_id,kind,title,uri,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, runId, stepId || null, artifact.projectArtifactId || null, String(artifact.kind || "result").slice(0, 80),
        String(artifact.title || "Run artifact").slice(0, 300), String(artifact.uri || "").slice(0, 4000), JSON.stringify(artifact.metadata || {}), createdAt);
    this.#appendEvent(runId, stepId, "artifact.recorded", { id, kind: artifact.kind, title: artifact.title, uri: artifact.uri }, createdAt);
    return id;
  }

  completeGoalStep(runId, stepId, { output = {}, evidence = null, tokens = 0, costUnits = 0 } = {}) {
    const run = this.get(runId);
    const step = run?.steps.find((item) => item.id === stepId && item.state === "running");
    if (!step) throw runtimeError("Goal step is not running.", "RUN_STEP_UNAVAILABLE");
    this.consumeBudget(runId, { steps: 1, tokens, costUnits });
    const changedAt = timestamp();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE run_steps SET state='completed',result_json=?,lease_id=NULL,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify(output || {}), changedAt, changedAt, stepId);
      this.db.prepare(`UPDATE run_step_attempts SET state='completed',output_json=?,completed_at=? WHERE step_id=? AND attempt=?`)
        .run(JSON.stringify(output || {}), changedAt, stepId, step.attempts);
      this.#appendEvent(runId, stepId, "step.completed", { output }, changedAt);
    })();
    if (evidence) this.addEvidence(runId, stepId, evidence);
    const updated = this.get(runId);
    const next = this.nextRunnableStep(runId);
    if (next) return { run: updated, nextStep: next };
    const incomplete = updated.steps.some((item) => item.state !== "completed");
    if (incomplete) return { run: updated, nextStep: null };
    const verification = [...updated.steps].reverse().find((item) => item.kind === "verification");
    if (!verification?.result?.verified) {
      this.db.prepare("UPDATE agent_goals SET status='partial',updated_at=? WHERE run_id=?").run(timestamp(), runId);
      return { run: this.fail(runId, Object.assign(new Error("The goal finished without evidence that its success criteria were met."), { code: "GOAL_UNVERIFIED" })), nextStep: null };
    }
    this.#transition(runId, "observing", { reason: "all planned steps completed" });
    this.#transition(runId, "evaluating", { reason: "verification evidence recorded", stepId: verification.id });
    this.#transition(runId, "completed", { reason: "success criteria verified", stepId: verification.id });
    this.db.prepare("UPDATE agent_goals SET status='completed',updated_at=? WHERE run_id=?").run(timestamp(), runId);
    this.db.prepare("UPDATE run_plans SET status='completed' WHERE run_id=? AND status='active'").run(runId);
    return { run: this.get(runId), nextStep: null };
  }

  failGoalStep(runId, stepId, error) {
    const run = this.get(runId);
    const step = run?.steps.find((item) => item.id === stepId && item.state === "running");
    if (!step) throw runtimeError("Goal step is not running.", "RUN_STEP_UNAVAILABLE");
    const normalized = { code: String(error?.code || "STEP_FAILED").slice(0, 100), message: String(error?.message || error).slice(0, 2000) };
    const changedAt = timestamp();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE run_steps SET state='failed',error_json=?,lease_id=NULL,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify(normalized), changedAt, changedAt, stepId);
      this.db.prepare(`UPDATE run_step_attempts SET state='failed',error_json=?,completed_at=? WHERE step_id=? AND attempt=?`)
        .run(JSON.stringify(normalized), changedAt, stepId, step.attempts);
      this.#appendEvent(runId, stepId, "step.failed", normalized, changedAt);
      this.db.prepare("UPDATE agent_runs SET resume_state='executing' WHERE id=?").run(runId);
      this.db.prepare("UPDATE agent_goals SET status='paused',updated_at=? WHERE run_id=?").run(changedAt, runId);
    })();
    return this.#transition(runId, "paused", { reason: normalized.message, stepId, payload: normalized });
  }

  retryGoalStep(runId, stepId) {
    const run = this.get(runId);
    const step = run?.steps.find((item) => item.id === stepId);
    if (!step || step.state !== "failed") throw runtimeError("Only a failed step can be retried.", "RUN_STEP_NOT_FAILED");
    if (step.attempts > step.maxRetries) throw runtimeError("This step's retry budget is exhausted.", "RUN_RETRY_BUDGET_EXCEEDED");
    this.db.prepare("UPDATE run_steps SET state='pending',error_json='{}',completed_at=NULL,updated_at=? WHERE id=?").run(timestamp(), stepId);
    this.addEvent(runId, stepId, "step.retry-requested", { nextAttempt: step.attempts + 1 });
    return this.startGoal(runId);
  }

  resolveGoalApproval(runId, toolRunId, decision, result = {}) {
    const run = this.get(runId);
    if (!run || run.executor !== "goal-runner-v1" || run.state !== "waiting_for_approval") return run;
    const waitingEvent = [...run.events].reverse().find((event) => event.type === "state.transition.requested" && event.payload?.to === "waiting_for_approval" && event.payload?.toolRunId === toolRunId);
    const step = run.steps.find((item) => item.id === waitingEvent?.stepId) || run.steps.find((item) => item.state === "pending");
    if (!step) throw runtimeError("The approved goal step could not be found.", "RUN_STEP_UNAVAILABLE");
    const changedAt = timestamp();
    if (decision === "approved") {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE run_steps SET state='completed',result_json=?,lease_id=NULL,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?`)
          .run(JSON.stringify({ approved: true, toolRunId, result }), changedAt, changedAt, step.id);
        this.db.prepare(`UPDATE run_step_attempts SET state='completed',output_json=?,completed_at=? WHERE step_id=? AND attempt=?`)
          .run(JSON.stringify({ approved: true, toolRunId, result }), changedAt, step.id, step.attempts);
        this.#appendEvent(runId, step.id, "approval.approved", { toolRunId, result }, changedAt);
        this.db.prepare("UPDATE agent_runs SET resume_state='executing' WHERE id=?").run(runId);
      })();
      this.addEvidence(runId, step.id, { kind: "approved-effect", title: step.title, payload: { toolRunId, result } });
      this.addArtifact(runId, step.id, {
        kind: "approved-effect",
        title: step.title,
        uri: result?.relativePath || result?.path || "",
        metadata: { toolRunId, approved: true }
      });
      return this.releaseApproval(runId, decision);
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE run_steps SET state='failed',error_json=?,completed_at=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify({ code: "APPROVAL_REJECTED", message: "The user rejected this step." }), changedAt, changedAt, step.id);
      this.db.prepare(`UPDATE run_step_attempts SET state='failed',error_json=?,completed_at=? WHERE step_id=? AND attempt=?`)
        .run(JSON.stringify({ code: "APPROVAL_REJECTED", message: "The user rejected this step." }), changedAt, step.id, step.attempts);
      this.#appendEvent(runId, step.id, "approval.rejected", { toolRunId }, changedAt);
      this.db.prepare("UPDATE agent_runs SET resume_state='executing' WHERE id=?").run(runId);
    })();
    return this.releaseApproval(runId, decision);
  }

  listArtifacts(runId) {
    return this.db.prepare(`SELECT id,run_id AS runId,step_id AS stepId,project_artifact_id AS projectArtifactId,kind,title,uri,metadata_json AS metadataJson,created_at AS createdAt FROM run_artifacts WHERE run_id=? ORDER BY created_at`).all(runId)
      .map((row) => ({ ...row, metadata: parseJson(row.metadataJson, {}), metadataJson: undefined }));
  }

  leaseStep(runId, requestedStepId = null) {
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(runId);
      if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
      if (run.state !== "executing") throw runtimeError("Agent run is not executable.", "RUN_NOT_EXECUTABLE");
      this.assertCanContinue(runId);
      const step = requestedStepId
        ? this.db.prepare("SELECT * FROM run_steps WHERE id = ? AND run_id = ?").get(requestedStepId, runId)
        : this.db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND state = 'pending' ORDER BY position LIMIT 1").get(runId);
      if (!step) throw runtimeError("No runnable agent step is available.", "RUN_STEP_UNAVAILABLE");
      const nowMs = this.clock();
      if (step.state === "running" && Date.parse(step.lease_expires_at || "") > nowMs) {
        throw runtimeError("This agent step is already leased.", "RUN_STEP_LEASED");
      }
      if (!new Set(["pending", "running"]).has(step.state)) throw runtimeError("Agent step is not runnable.", "RUN_STEP_UNAVAILABLE");
      const attempts = Number(step.attempts || 0) + 1;
      if (attempts > Number(step.max_retries || 0) + 1) throw runtimeError("Agent step retry budget is exhausted.", "RUN_RETRY_BUDGET_EXCEEDED");
      const leaseId = crypto.randomUUID();
      const leasedAt = timestamp();
      const leaseExpiresAt = new Date(nowMs + this.leaseMs).toISOString();
      const before = this.#appendEvent(runId, step.id, "step.lease.requested", { attempt: attempts }, leasedAt);
      this.#checkpoint(runId, step.id, before, "executing", { phase: "before-lease" }, leasedAt);
      this.db.prepare(`
        UPDATE run_steps SET state = 'running', attempts = ?, lease_id = ?, lease_expires_at = ?,
          started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
      `).run(attempts, leaseId, leaseExpiresAt, leasedAt, leasedAt, step.id);
      if (this.db.prepare("SELECT executor FROM agent_runs WHERE id=?").get(runId)?.executor === "goal-runner-v1") {
        const inputs = this.db.prepare("SELECT inputs_json AS inputsJson FROM run_step_details WHERE step_id=?").get(step.id)?.inputsJson || "{}";
        this.db.prepare(`INSERT INTO run_step_attempts(id,run_id,step_id,attempt,state,input_json,started_at) VALUES(?,?,?,?, 'running',?,?)`)
          .run(crypto.randomUUID(), runId, step.id, attempts, inputs, leasedAt);
      }
      const after = this.#appendEvent(runId, step.id, "step.lease.acquired", { leaseId, leaseExpiresAt, attempt: attempts }, leasedAt);
      this.#checkpoint(runId, step.id, after, "executing", { phase: "after-lease", leaseId }, leasedAt);
      return { ...this.get(runId), leaseId, stepId: step.id };
    })();
  }

  recordEffect(runId, stepId, phase, effect, payload = {}) {
    if (!new Set(["before", "after"]).has(phase)) throw runtimeError("Effect phase must be before or after.", "RUN_EFFECT_INVALID", 400);
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(runId);
      if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
      const sequence = this.#appendEvent(runId, stepId, `effect.${phase}`, { effect, ...payload });
      this.#checkpoint(runId, stepId, sequence, run.state, { phase, effect, ...payload });
      return sequence;
    })();
  }

  consumeBudget(runId, usage = {}) {
    const delta = {
      steps: boundedInteger(usage.steps, 0, 0, 1000),
      toolCalls: boundedInteger(usage.toolCalls, 0, 0, 1000),
      retries: boundedInteger(usage.retries, 0, 0, 1000),
      tokens: boundedInteger(usage.tokens, 0, 0, 10_000_000),
      costUnits: Math.max(0, Math.min(1_000_000, Number(usage.costUnits) || 0))
    };
    this.db.prepare(`
      UPDATE run_budgets SET used_steps = used_steps + ?, used_tool_calls = used_tool_calls + ?,
        used_retries = used_retries + ?, used_tokens = used_tokens + ?, used_cost_units = used_cost_units + ?, updated_at = ?
      WHERE run_id = ?
    `).run(delta.steps, delta.toolCalls, delta.retries, delta.tokens, delta.costUnits, timestamp(), runId);
    return this.assertCanContinue(runId);
  }

  assertCanContinue(runId) {
    const row = this.db.prepare(`
      SELECT r.state, b.* FROM agent_runs r JOIN run_budgets b ON b.run_id = r.id WHERE r.id = ?
    `).get(runId);
    if (!row) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    if (row.state === "paused") throw runtimeError("Agent run is paused.", "RUN_PAUSED");
    if (row.state === "cancelled") throw runtimeError("Agent run was cancelled.", "RUN_CANCELLED");
    if (TERMINAL_RUN_STATES.includes(row.state)) throw runtimeError("Agent run is no longer active.", "RUN_NOT_ACTIVE");
    const elapsed = Math.max(0, this.clock() - Date.parse(row.started_at));
    const exceeded = elapsed > row.max_runtime_ms ? "runtime"
      : row.used_steps > row.max_steps ? "steps"
        : row.used_tool_calls > row.max_tool_calls ? "tool calls"
          : row.used_retries > row.max_retries ? "retries"
            : row.used_tokens > row.max_tokens ? "tokens"
              : row.used_cost_units > row.max_cost_units ? "estimated cost" : "";
    if (exceeded) throw runtimeError(`Agent run ${exceeded} budget was exceeded.`, "RUN_BUDGET_EXCEEDED");
    return this.get(runId).budgets;
  }

  complete(runId, { output = {}, tokens = 0, costUnits = 0 } = {}) {
    const run = this.get(runId);
    if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    const step = run.steps.find((item) => item.state === "running");
    if (!step) throw runtimeError("Agent run has no active step.", "RUN_STEP_UNAVAILABLE");
    this.consumeBudget(runId, { steps: 1, tokens, costUnits });
    this.db.transaction(() => {
      const changedAt = timestamp();
      const before = this.#appendEvent(runId, step.id, "step.completion.requested", { output }, changedAt);
      this.#checkpoint(runId, step.id, before, "executing", { phase: "before-step-complete" }, changedAt);
      this.db.prepare(`
        UPDATE run_steps SET state = 'completed', result_json = ?, lease_id = NULL, lease_expires_at = NULL,
          completed_at = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(output || {}), changedAt, changedAt, step.id);
      const after = this.#appendEvent(runId, step.id, "step.completed", { output }, changedAt);
      this.#checkpoint(runId, step.id, after, "executing", { phase: "after-step-complete" }, changedAt);
    })();
    this.#transition(runId, "observing", { reason: "response persisted", stepId: step.id });
    this.#transition(runId, "evaluating", { reason: "completion evidence recorded", stepId: step.id });
    return this.#transition(runId, "completed", { reason: "single-step chat run verified", stepId: step.id });
  }

  waitForApproval(runId, { toolRunId = "", toolName = "" } = {}) {
    const run = this.get(runId);
    if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    const step = run.steps.find((item) => item.state === "running");
    if (!step) throw runtimeError("Agent run has no active step.", "RUN_STEP_UNAVAILABLE");
    this.db.prepare(`
      UPDATE run_steps SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
    `).run(timestamp(), step.id);
    return this.#transition(runId, "waiting_for_approval", {
      reason: `waiting for approval of ${toolName || "tool action"}`,
      stepId: step.id,
      payload: { toolRunId, toolName }
    });
  }

  releaseApproval(runId, decision) {
    const run = this.get(runId);
    if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    if (run.state !== "waiting_for_approval") throw runtimeError("Agent run is not waiting for approval.", "RUN_NOT_WAITING");
    this.db.prepare("UPDATE agent_runs SET resume_state = 'executing' WHERE id = ?").run(runId);
    return this.#transition(runId, "paused", { reason: `tool action ${decision}; continuation is ready` });
  }

  pause(runId, reason = "paused by user") {
    const run = this.get(runId);
    if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    if (run.state === "paused") return run;
    if (TERMINAL_RUN_STATES.includes(run.state)) throw runtimeError("Completed agent runs cannot be paused.", "RUN_NOT_ACTIVE");
    this.db.prepare("UPDATE agent_runs SET resume_state = ? WHERE id = ?").run(
      ["idle", "observing", "evaluating", "revising"].includes(run.state) ? "planning" : run.state,
      runId
    );
    if (run.executor === "goal-runner-v1") {
      const changedAt = timestamp();
      this.db.prepare(`UPDATE run_step_attempts SET state='cancelled',error_json=?,completed_at=?
        WHERE run_id=? AND state='running'`).run(JSON.stringify({ code: "RUN_PAUSED", message: reason }), changedAt, runId);
      this.db.prepare("UPDATE agent_goals SET status='paused',updated_at=? WHERE run_id=?").run(changedAt, runId);
    }
    this.db.prepare(`
      UPDATE run_steps SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND state = 'running'
    `).run(timestamp(), runId);
    return this.#transition(runId, "paused", { reason });
  }

  prepareResume(runId, conversationId) {
    const run = this.get(runId);
    if (!run || run.conversationId !== conversationId) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    if (run.state !== "paused") throw runtimeError("Only a paused agent run can resume.", "RUN_NOT_PAUSED");
    const nextState = ["planning", "waiting_for_approval", "executing"].includes(run.resumeState) ? run.resumeState : "executing";
    if (nextState === "planning") {
      this.#transition(runId, "planning", { reason: "resumed by user" });
      this.#transition(runId, "executing", { reason: "existing chat plan resumed" });
    } else {
      this.#transition(runId, nextState, { reason: "resumed by user" });
      if (nextState === "waiting_for_approval") return this.get(runId);
    }
    return this.leaseStep(runId);
  }

  cancel(runId, reason = "cancelled by user") {
    const run = this.get(runId);
    if (!run) throw runtimeError("Agent run not found.", "RUN_NOT_FOUND", 404);
    if (run.state === "cancelled") return run;
    if (TERMINAL_RUN_STATES.includes(run.state)) throw runtimeError("Completed agent runs cannot be cancelled.", "RUN_NOT_ACTIVE");
    this.db.prepare(`
      UPDATE run_steps SET state = 'cancelled', lease_id = NULL, lease_expires_at = NULL,
        error_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND state IN ('pending','running')
    `).run(JSON.stringify({ code: "RUN_CANCELLED", message: reason }), timestamp(), timestamp(), runId);
    if (run.executor === "goal-runner-v1") this.db.prepare("UPDATE agent_goals SET status='cancelled',updated_at=? WHERE run_id=?").run(timestamp(), runId);
    return this.#transition(runId, "cancelled", { reason });
  }

  fail(runId, error) {
    const run = this.get(runId);
    if (!run || TERMINAL_RUN_STATES.includes(run.state)) return run;
    const normalized = {
      code: String(error?.code || "RUN_FAILED").slice(0, 100),
      message: String(error?.message || error || "Agent run failed.").slice(0, 2000)
    };
    this.db.prepare(`
      UPDATE run_steps SET state = 'failed', lease_id = NULL, lease_expires_at = NULL,
        error_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND state = 'running'
    `).run(JSON.stringify(normalized), timestamp(), timestamp(), runId);
    if (run.executor === "goal-runner-v1" && run.goal?.status !== "partial") {
      this.db.prepare("UPDATE agent_goals SET status='failed',updated_at=? WHERE run_id=?").run(timestamp(), runId);
    }
    return this.#transition(runId, "failed", { reason: normalized.message, payload: { code: normalized.code } });
  }

  recoverAbandonedRuns() {
    const recoverable = this.db.prepare(`
      SELECT id, state FROM agent_runs
      WHERE state IN ('idle','planning','executing','observing','evaluating','revising')
    `).all();
    for (const run of recoverable) this.pause(run.id, `application restarted while run was ${run.state}`);
    return { paused: recoverable.length };
  }

  get(id) {
    const row = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, objective, state, executor, provider_id AS providerId,
        model_id AS modelId, request_json AS requestJson, resume_state AS resumeState, error,
        created_at AS createdAt, updated_at AS updatedAt, started_at AS startedAt, completed_at AS completedAt
      FROM agent_runs WHERE id = ?
    `).get(id);
    if (!row) return null;
    row.request = parseJson(row.requestJson, {});
    delete row.requestJson;
    row.plans = this.db.prepare(`
      SELECT p.id,p.revision,p.status,p.summary,p.created_at AS createdAt,d.plan_json AS planJson,d.edited_at AS editedAt,d.approved_at AS approvedAt
      FROM run_plans p LEFT JOIN run_plan_details d ON d.plan_id=p.id WHERE p.run_id=? ORDER BY p.revision
    `).all(id).map((plan) => ({ ...plan, definition: parseJson(plan.planJson, null), planJson: undefined }));
    row.steps = this.db.prepare(`
      SELECT s.id,s.plan_id AS planId,s.position,s.title,s.description,s.kind,s.state,s.attempts,
        s.max_retries AS maxRetries,s.lease_expires_at AS leaseExpiresAt,s.result_json AS resultJson,
        s.error_json AS errorJson,s.created_at AS createdAt,s.updated_at AS updatedAt,
        s.started_at AS startedAt,s.completed_at AS completedAt,d.external_id AS externalId,
        d.dependencies_json AS dependenciesJson,d.inputs_json AS inputsJson,d.expected_evidence AS expectedEvidence,
        d.verification_criteria AS verificationCriteria,d.approval_policy AS approvalPolicy,d.tool_name AS toolName
      FROM run_steps s JOIN run_plans p ON p.id=s.plan_id LEFT JOIN run_step_details d ON d.step_id=s.id
      WHERE s.run_id=? AND p.status IN ('active','completed') ORDER BY p.revision DESC,s.position
    `).all(id).map((step) => ({
      ...step,
      result: parseJson(step.resultJson, {}),
      error: parseJson(step.errorJson, {}),
      dependencies: parseJson(step.dependenciesJson, []),
      inputs: parseJson(step.inputsJson, {}),
      attemptsHistory: this.db.prepare(`SELECT id,attempt,state,input_json AS inputJson,output_json AS outputJson,error_json AS errorJson,started_at AS startedAt,completed_at AS completedAt FROM run_step_attempts WHERE step_id=? ORDER BY attempt`).all(step.id).map((attempt) => ({ ...attempt, input: parseJson(attempt.inputJson, {}), output: parseJson(attempt.outputJson, {}), error: parseJson(attempt.errorJson, {}), inputJson: undefined, outputJson: undefined, errorJson: undefined })),
      resultJson: undefined,
      errorJson: undefined,
      dependenciesJson: undefined,
      inputsJson: undefined
    }));
    row.goal = this.db.prepare(`SELECT id,project_id AS projectId,pack_id AS packId,success_criteria_json AS successCriteriaJson,status,created_at AS createdAt,updated_at AS updatedAt FROM agent_goals WHERE run_id=?`).get(id) || null;
    if (row.goal) { row.goal.successCriteria = parseJson(row.goal.successCriteriaJson, []); delete row.goal.successCriteriaJson; }
    const budget = this.db.prepare(`
      SELECT max_steps AS maxSteps, max_runtime_ms AS maxRuntimeMs, max_tool_calls AS maxToolCalls,
        max_retries AS maxRetries, max_tokens AS maxTokens, max_cost_units AS maxCostUnits,
        used_steps AS usedSteps, used_tool_calls AS usedToolCalls, used_retries AS usedRetries,
        used_tokens AS usedTokens, used_cost_units AS usedCostUnits, started_at AS startedAt, updated_at AS updatedAt
      FROM run_budgets WHERE run_id = ?
    `).get(id);
    row.budgets = budget || null;
    row.events = this.db.prepare(`
      SELECT id, step_id AS stepId, sequence, type, payload_json AS payloadJson, created_at AS createdAt
      FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 200
    `).all(id).reverse().map((event) => ({ ...event, payload: parseJson(event.payloadJson, {}), payloadJson: undefined }));
    row.checkpoints = this.db.prepare(`
      SELECT id, step_id AS stepId, event_sequence AS eventSequence, state, data_json AS dataJson, created_at AS createdAt
      FROM run_checkpoints WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 50
    `).all(id).reverse().map((checkpoint) => ({ ...checkpoint, data: parseJson(checkpoint.dataJson, {}), dataJson: undefined }));
    row.evidence = this.db.prepare(`SELECT id,step_id AS stepId,kind,title,payload_json AS payloadJson,citation,created_at AS createdAt FROM run_evidence WHERE run_id=? ORDER BY created_at`).all(id)
      .map((item) => ({ ...item, payload: parseJson(item.payloadJson, {}), payloadJson: undefined }));
    row.artifacts = this.listArtifacts(id);
    return row;
  }

  getActiveForConversation(conversationId) {
    const row = this.db.prepare(`
      SELECT id FROM agent_runs WHERE conversation_id = ?
        AND state IN ('idle','planning','waiting_for_approval','executing','observing','evaluating','revising','paused')
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId);
    return row ? this.get(row.id) : null;
  }

  list({ conversationId = "", state = "", limit = 50 } = {}) {
    const clauses = [];
    const parameters = {};
    if (conversationId) { clauses.push("conversation_id = @conversationId"); parameters.conversationId = conversationId; }
    if (state) {
      if (!RUN_STATES.includes(state)) throw runtimeError("Unknown agent run state.", "RUN_STATE_INVALID", 400);
      clauses.push("state = @state"); parameters.state = state;
    }
    parameters.limit = boundedInteger(limit, 50, 1, 200);
    return this.db.prepare(`
      SELECT id FROM agent_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT @limit
    `).all(parameters).map((row) => this.get(row.id));
  }
}
