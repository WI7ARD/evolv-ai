import { agentMayRunStep, agentModelOverride, agentSystemPrompt, listAgents, resolveAgent } from "./agents.mjs";
import { parsePlannerJson, plannerSystemPrompt, stepToolUse, validateGoalPlan, normalizeGoalBudgets } from "./goal-contracts.mjs";

function fail(message, code = "GOAL_RUNNER_ERROR", status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function parseOutput(value) {
  try { return JSON.parse(value); } catch { return { text: String(value || "") }; }
}

export class GoalRunnerService {
  constructor({ database, agentRuntime, toolRegistry, providerService, vaultService, projectService, marketplace = null }) {
    Object.assign(this, { database, agentRuntime, toolRegistry, providerService, vaultService, projectService, marketplace });
  }

  // The specialists this goal may be shared out between: the built-in roster,
  // plus any the run's own pack ships.
  //
  // Only the run's pack. A pack installed for something else has no business
  // putting a voice into every goal on the machine, and a plan that silently
  // changed hands because of an unrelated install would be impossible to
  // account for afterwards.
  //
  // Pack agents arrive namespaced as packId:agentId, so one cannot take a
  // built-in's name, and the origin of a voice is readable in the plan itself.
  #roster(packId = "") {
    if (!packId || typeof this.marketplace?.runtime !== "function") return listAgents();
    const extra = this.marketplace.runtime()
      .filter((item) => item.type === "agent" && item.packId === packId);
    return listAgents(extra);
  }

  availableTools() {
    const approvalTools = new Set(["propose_web_research", "propose_workspace_edit", "propose_workspace_create", "propose_engineering_check", "propose_obsidian_create", "propose_sandbox_promotion"]);
    // Sandbox writes are automatic on purpose: a plan should be free to try a
    // change and check it, because none of that reaches the real project. Only
    // the promotion is approval-gated.
    return this.toolRegistry.list()
      .filter((tool) => tool.enabled && (tool.risk === "read" || tool.risk === "sandbox" || approvalTools.has(tool.name)))
      .map((tool) => tool.name);
  }

  async #complete(providerId, model, messages, { temperature = 0.2, maxTokens = 4096, signal = AbortSignal.timeout(180_000) } = {}) {
    let content = "";
    let thinking = "";
    await this.providerService.streamRound(providerId, {
      model, messages, stream: true, options: { temperature, maxTokens }
    }, signal, (chunk) => {
      content += chunk?.message?.content || "";
      thinking += chunk?.message?.thinking || "";
    });
    return { content: content.trim(), thinking: thinking.trim() };
  }

  async #fallbackRoute(providerId, model, runId = "", phase = "planning") {
    if (providerId === "ollama") throw fail("The selected local model is unavailable and no silent fallback is permitted.", "GOAL_MODEL_UNAVAILABLE", 502);
    const models = await this.providerService.models("ollama").catch(() => []);
    const fallback = models.find((item) => item.capabilities?.includes("completion")) || models[0];
    if (!fallback) throw fail("The selected model failed and no local fallback model is available.", "GOAL_FALLBACK_UNAVAILABLE", 502);
    if (runId) this.agentRuntime.addEvent(runId, null, "provider.fallback", {
      phase, fromProvider: providerId, fromModel: model, toProvider: "ollama", toModel: fallback.id,
      reason: "selected provider failed"
    });
    return { providerId: "ollama", model: fallback.id, fallback: true, fromProvider: providerId, fromModel: model };
  }

  async proposePlan({ objective, successCriteria, providerId, model, budgets, packId = "" }) {
    const tools = this.availableTools();
    const normalizedBudgets = normalizeGoalBudgets(budgets);
    const roster = this.#roster(packId);
    const messages = [
      { role: "system", content: plannerSystemPrompt(tools, roster) },
      { role: "user", content: `Goal:\n${objective}\n\nSuccess criteria:\n${successCriteria.map((item) => `- ${item}`).join("\n")}\n\nBudgets:\n${JSON.stringify(normalizedBudgets)}` }
    ];
    let route = { providerId, model, fallback: false };
    let result;
    try { result = await this.#complete(route.providerId, route.model, messages, { temperature: 0.1, maxTokens: 5000 }); }
    catch {
      route = await this.#fallbackRoute(providerId, model, "", "planning");
      result = await this.#complete(route.providerId, route.model, messages, { temperature: 0.1, maxTokens: 5000 });
    }
    const plan = validateGoalPlan(parsePlannerJson(result.content), { availableTools: tools, budgets: normalizedBudgets, roster });
    return { plan, route, budgets: normalizedBudgets };
  }

  async create(body) {
    const objective = String(body.objective || "").trim();
    if (objective.length < 3 || objective.length > 20_000) throw fail("Enter a goal between 3 and 20,000 characters.", "GOAL_INVALID", 400);
    const successCriteria = Array.isArray(body.successCriteria)
      ? body.successCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : String(body.successCriteria || "").split(/\r?\n/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean).slice(0, 20);
    if (!successCriteria.length) throw fail("Add at least one success criterion.", "GOAL_CRITERIA_REQUIRED", 400);
    const project = this.projectService.get(body.projectId) || this.projectService.defaultProject();
    if (!project) throw fail("Choose an active project.", "PROJECT_NOT_FOUND", 404);
    let providerId = String(body.provider || "ollama");
    let model = String(body.model || "");
    if (!model || model === "auto") {
      const models = await this.providerService.models(providerId).catch(() => []);
      const chosen = models[0];
      if (!chosen) throw fail("No available model can plan this goal.", "GOAL_MODEL_UNAVAILABLE", 409);
      model = chosen.id;
    }
    const packId = String(body.packId || "");
    const proposed = body.plan
      ? {
        plan: validateGoalPlan(body.plan, {
          availableTools: this.availableTools(), budgets: normalizeGoalBudgets(body.budgets), roster: this.#roster(packId)
        }),
        route: { providerId, model, fallback: false },
        budgets: normalizeGoalBudgets(body.budgets)
      }
      : await this.proposePlan({ objective, successCriteria, providerId, model, budgets: body.budgets, packId });
    providerId = proposed.route.providerId;
    model = proposed.route.model;
    const conversation = this.database.createConversation(`Agent · ${objective.slice(0, 70)}`);
    this.database.addMessage({ conversationId: conversation.id, role: "user", content: objective, status: "complete", metadata: { agentGoal: true, successCriteria } });
    const run = this.agentRuntime.createGoalRun({
      conversationId: conversation.id, projectId: project.id, packId, objective, successCriteria,
      providerId, modelId: model, budgets: proposed.budgets, plan: proposed.plan, availableTools: this.availableTools(),
      request: { provider: providerId, model, projectId: project.id, packId, successCriteria, fallback: proposed.route.fallback }
    });
    this.projectService.attachRun(project.id, run.id);
    this.agentRuntime.addEvent(run.id, null, "routing.selected", {
      phase: "planning", provider: providerId, model, fallback: proposed.route.fallback,
      reasons: proposed.route.fallback ? ["selected provider failed", "local fallback available"] : ["user-selected goal planner"]
    });
    if (proposed.route.fallback) this.agentRuntime.addEvent(run.id, null, "provider.fallback", {
      phase: "planning", fromProvider: proposed.route.fromProvider, fromModel: proposed.route.fromModel,
      toProvider: providerId, toModel: model, reason: "selected planning provider failed"
    });
    return this.agentRuntime.get(run.id);
  }

  revise(runId, plan) {
    // A revision is re-validated from scratch, so it needs the same roster the
    // plan was written against or a pack specialist would be corrected away.
    const packId = this.agentRuntime.get(runId)?.goal?.packId || "";
    return this.agentRuntime.reviseGoalPlan(runId, plan, {
      availableTools: this.availableTools(), roster: this.#roster(packId)
    });
  }

  async approve(runId) {
    const approved = this.agentRuntime.approveGoalPlan(runId);
    const project = this.projectService.get(approved.goal?.projectId);
    if (project && this.vaultService.connected()) await this.vaultService.syncRunJournal({ run: this.agentRuntime.get(runId), project });
    return this.agentRuntime.get(runId);
  }

  async replan(runId, { reason = "", plan = null } = {}) {
    const run = this.agentRuntime.get(runId);
    if (!run || run.executor !== "goal-runner-v1") throw fail("Goal run not found.", "RUN_NOT_FOUND", 404);
    if (run.state !== "paused" && run.state !== "waiting_for_approval") throw fail("Pause the goal before replanning.", "RUN_REPLAN_NOT_PAUSED");
    if (plan) return this.revise(runId, plan);
    let route = { providerId: run.providerId, model: run.modelId, fallback: false };
    const messages = [
      { role: "system", content: plannerSystemPrompt(this.availableTools()) },
      { role: "user", content: `Revise this goal plan. Preserve useful completed evidence, resolve the stated problem, and return a complete replacement plan.\nGoal: ${run.objective}\nSuccess criteria: ${JSON.stringify(run.goal.successCriteria)}\nReason: ${String(reason).slice(0, 2000)}\nCurrent run: ${JSON.stringify({ steps: run.steps, evidence: run.evidence }).slice(0, 30_000)}` }
    ];
    let response;
    try { response = await this.#complete(route.providerId, route.model, messages, { temperature: 0.1, maxTokens: 5000 }); }
    catch {
      route = await this.#fallbackRoute(route.providerId, route.model, runId, "replanning");
      response = await this.#complete(route.providerId, route.model, messages, { temperature: 0.1, maxTokens: 5000 });
    }
    const revised = this.revise(runId, parsePlannerJson(response.content));
    this.agentRuntime.addEvent(runId, null, "routing.selected", { phase: "replanning", provider: route.providerId, model: route.model, fallback: route.fallback });
    return revised;
  }

  #resolvedInputs(step, run) {
    const replace = (value) => {
      if (typeof value === "string") return value.replace(/\{\{steps\.([a-z0-9_-]+)\.output\}\}/gi, (_match, id) => {
        const source = run.steps.find((item) => item.externalId === id);
        return JSON.stringify(source?.result || {});
      });
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
      return value;
    };
    return replace(step.inputs || {});
  }

  // The step as the plan wrote it, which is where the agent is recorded. Steps
  // are stored in their own table without it, and the whole plan is kept as
  // JSON — so this reads it back rather than adding a column for one field.
  // Matched on the plan's own step id, which run_step_details keeps as
  // externalId.
  #plannedStep(run, step) {
    const plan = run.plans?.find((item) => item.id === step.planId) || run.plans?.at(-1);
    return plan?.definition?.steps?.find((item) => item.id === step.externalId) || null;
  }

  async #modelStep(run, step, signal) {
    const intelligence = this.database.getSettings().intelligence || {};
    const cloud = run.providerId !== "ollama";
    const vaultAllowed = !cloud || (intelligence.vaultCloudProviders || []).includes(run.providerId);
    const projectAllowed = !cloud || (intelligence.projectCloudProviders || []).includes(run.providerId);
    const byStep = new Map(run.steps.map((item) => [item.id, item]));
    const withheld = { vault: 0, project: 0 };
    const context = run.evidence.filter((item) => {
      const source = byStep.get(item.stepId);
      const vault = ["memory_search", "obsidian_search", "obsidian_read"].includes(source?.kind)
        || ["search_memory", "list_obsidian_notes", "search_obsidian", "read_obsidian_note", "get_obsidian_backlinks"].includes(source?.toolName);
      const project = ["project_search", "project_read"].includes(source?.kind)
        || ["list_workspace_files", "read_workspace_text", "search_workspace_text", "search_project_knowledge"].includes(source?.toolName);
      if (vault && !vaultAllowed) { withheld.vault += 1; return false; }
      if (project && !projectAllowed) { withheld.project += 1; return false; }
      return true;
    }).map((item) => ({ title: item.title, kind: item.kind, payload: item.payload, citation: item.citation })).slice(-30);
    if (withheld.vault || withheld.project) this.agentRuntime.addEvent(run.id, step.id, "context.withheld", {
      provider: run.providerId, vaultItems: withheld.vault, projectItems: withheld.project,
      reason: "provider-specific cloud sharing is disabled"
    });
    const verification = step.kind === "verification";
    const boundary = verification
      ? "You are Evolv's verification gate. Return JSON only: {\"verified\":boolean,\"criteria\":[{\"criterion\":string,\"met\":boolean,\"evidence\":string}],\"gaps\":[string],\"summary\":string}. Never mark a criterion met without recorded evidence."
      : "You are executing one approved step in Evolv's bounded goal runner. Use only the provided local evidence. State what the evidence supports, identify uncertainty, and do not claim actions that were not recorded.";
    // The plan says which specialist this step belongs to. The boundary above
    // stays first and unaltered — the role describes how to do the step, not
    // what the runner is permitted to do.
    // Resolved against the run's own roster, so a pack specialist keeps its
    // voice when the step actually executes rather than only in the plan.
    const agent = resolveAgent(this.#plannedStep(run, step)?.agent, {
      step: { type: step.kind }, roster: this.#roster(run.goal?.packId)
    });
    const system = agentSystemPrompt(agent, boundary);
    this.agentRuntime.addEvent(run.id, step.id, "agent.assigned", { agent: agent.id, name: agent.name });
    const messages = [{ role: "system", content: system }, { role: "user", content: JSON.stringify({
      goal: run.objective, successCriteria: run.goal.successCriteria, step: { title: step.title, description: step.description, verificationCriteria: step.verificationCriteria }, evidence: context
    }).slice(0, 60_000) }];
    // A model pinned to this specialist is tried first, then the run's own.
    // An override that fails costs the step nothing: the run's model is still
    // there, and is what would have been used anyway.
    const override = agentModelOverride(this.database.getSettings(), agent.id);
    const candidates = [
      ...(override && (override.providerId !== run.providerId || override.model !== run.modelId)
        ? [{ ...override, fallback: false, agentOverride: true }] : []),
      { providerId: run.providerId, model: run.modelId, fallback: false }
    ];
    // A verification gate returning JSON stays at zero whatever the critic
    // prefers; everywhere else the specialist's own temperature applies.
    const temperature = verification ? 0 : agent.temperature;
    let route = null;
    let response;
    for (const candidate of candidates) {
      try {
        response = await this.#complete(candidate.providerId, candidate.model, messages, { temperature, maxTokens: 4096, signal });
        route = candidate;
        break;
      } catch (error) {
        // A cancelled run is not a failed model, and must not be retried
        // against a second one.
        if (signal?.aborted) throw error;
      }
    }
    if (!route) {
      route = await this.#fallbackRoute(run.providerId, run.modelId, run.id, verification ? "verification" : "execution");
      response = await this.#complete(route.providerId, route.model, messages, { temperature: 0.1, maxTokens: 4096, signal });
    }
    if (route.agentOverride) this.agentRuntime.addEvent(run.id, step.id, "agent.model", { agent: agent.id, provider: route.providerId, model: route.model });
    this.agentRuntime.addEvent(run.id, step.id, "routing.selected", { phase: verification ? "verification" : "execution", provider: route.providerId, model: route.model, fallback: route.fallback });
    if (verification) {
      try { return parsePlannerJson(response.content); }
      catch { return { verified: false, criteria: [], gaps: ["Verification model did not return valid structured evidence."], summary: response.content.slice(0, 4000) }; }
    }
    return { content: response.content, thinking: response.thinking };
  }

  async execute(runId, { signal = AbortSignal.timeout(20 * 60 * 1000), onEvent = () => {} } = {}) {
    const proposed = this.agentRuntime.get(runId);
    const plan = proposed?.plans?.find((item) => item.status === "active") || proposed?.plans?.at(-1);
    onEvent({ type: "plan", runId, revision: plan?.revision || 1, status: plan?.approvedAt ? "approved" : "proposed", plan: plan?.definition || null });
    for (const event of (proposed?.events || []).filter((item) => ["routing.selected", "provider.fallback"].includes(item.type))) {
      onEvent({ type: event.type === "provider.fallback" ? "fallback" : "routing", runId, stepId: event.stepId, ...event.payload });
    }
    let streamedSequence = Math.max(0, ...(proposed?.events || []).map((event) => Number(event.sequence) || 0));
    const emitNewRuntimeEvents = () => {
      const fresh = this.agentRuntime.get(runId);
      for (const event of (fresh?.events || []).filter((item) => item.sequence > streamedSequence)) {
        if (event.type === "provider.fallback") onEvent({ type: "fallback", runId, stepId: event.stepId, ...event.payload });
        else if (event.type === "routing.selected") onEvent({ type: "routing", runId, stepId: event.stepId, ...event.payload });
        else if (event.type === "context.withheld") onEvent({ type: "context", runId, stepId: event.stepId, ...event.payload });
        streamedSequence = Math.max(streamedSequence, Number(event.sequence) || 0);
      }
    };
    let started = this.agentRuntime.startGoal(runId);
    onEvent({ type: "run", run: started });
    while (true) {
      const run = this.agentRuntime.get(runId);
      if (run.state !== "executing") return run;
      const step = run.steps.find((item) => item.state === "running") || this.agentRuntime.nextRunnableStep(runId);
      if (!step) return run;
      if (step.state !== "running") started = this.agentRuntime.leaseStep(runId, step.id);
      const current = this.agentRuntime.get(runId);
      const active = current.steps.find((item) => item.id === step.id);
      onEvent({ type: "step", action: "started", step: active });
      try {
        let output;
        let toolResult = null;
        if (["analyze", "verification", "report"].includes(active.kind)) {
          output = await this.#modelStep(current, active, signal);
          emitNewRuntimeEvents();
        } else {
          const toolByKind = {
            project_search: "search_workspace_text", project_read: "read_workspace_text", memory_search: "search_memory",
            obsidian_search: "search_obsidian", obsidian_read: "read_obsidian_note"
          };
          const toolName = active.kind === "tool" ? active.toolName : toolByKind[active.kind];
          if (!toolName) throw fail(`No executor exists for step type ${active.kind}.`, "GOAL_STEP_UNSUPPORTED", 400);
          // The real gate. Plan validation reassigns a step whose specialist
          // cannot reach its tool, so arriving here means the plan was edited
          // after that or the step changed — either way the run stops rather
          // than letting a specialist reach past what it is allowed.
          const stepAgent = resolveAgent(this.#plannedStep(current, active)?.agent, {
            step: { type: active.kind }, roster: this.#roster(current.goal?.packId)
          });
          if (!agentMayRunStep(stepAgent, stepToolUse({ type: active.kind, tool: active.kind === "tool" ? toolName : "" }))) {
            throw fail(`${stepAgent.name} is not permitted to run ${toolName}.`, "GOAL_AGENT_NOT_PERMITTED", 403);
          }
          this.agentRuntime.consumeBudget(runId, { toolCalls: 1 });
          toolResult = await this.toolRegistry.execute(toolName, this.#resolvedInputs(active, current), {
            conversationId: current.conversationId, agentRunId: runId, projectId: current.goal.projectId,
            providerId: current.providerId, vaultAllowed: current.providerId === "ollama" || (this.database.getSettings().intelligence?.vaultCloudProviders || []).includes(current.providerId), signal
          });
          output = parseOutput(toolResult.output);
          this.agentRuntime.addEvent(runId, active.id, "tool.result", { tool: toolName, runId: toolResult.runId, ok: toolResult.ok, pendingApproval: toolResult.pendingApproval, durationMs: toolResult.durationMs });
          emitNewRuntimeEvents();
          onEvent({ type: "evidence", stepId: active.id, tool: toolName, result: output, ok: toolResult.ok });
          if (toolResult.pendingApproval) {
            this.agentRuntime.waitForApproval(runId, { toolRunId: toolResult.runId, toolName });
            await this.#syncJournal(runId);
            onEvent({ type: "approval", stepId: active.id, toolRunId: toolResult.runId, tool: toolName });
            return this.agentRuntime.get(runId);
          }
          if (!toolResult.ok) throw fail(output.error || `${toolName} failed.`, output.code || "GOAL_TOOL_FAILED");
        }
        const completion = this.agentRuntime.completeGoalStep(runId, active.id, {
          output,
          evidence: { kind: active.kind === "verification" ? "verification" : "step-result", title: active.title, payload: output,
            citation: output.path || output.relativePath || "" }
        });
        onEvent({ type: active.kind === "verification" ? "verification" : "step", action: "completed", stepId: active.id, output });
        await this.#syncJournal(runId);
        if (!completion.nextStep) return this.agentRuntime.get(runId);
        this.agentRuntime.leaseStep(runId, completion.nextStep.id);
      } catch (error) {
        const failed = this.agentRuntime.failGoalStep(runId, active.id, error);
        onEvent({ type: "error", stepId: active.id, code: error.code || "STEP_FAILED", message: error.message });
        await this.#syncJournal(runId);
        return failed;
      }
    }
  }

  async #syncJournal(runId) {
    if (!this.vaultService.connected()) return null;
    const run = this.agentRuntime.get(runId);
    const project = this.projectService.get(run.goal?.projectId);
    return project ? this.vaultService.syncRunJournal({ run, project }) : null;
  }

  async retry(runId, stepId, options = {}) {
    this.agentRuntime.retryGoalStep(runId, stepId);
    return this.execute(runId, options);
  }
}
