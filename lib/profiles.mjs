import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "./database.mjs";
import { createToolRegistry } from "./tools.mjs";
import { createProviderService } from "./providers.mjs";
import { ObsidianVaultService } from "./obsidian-vault.mjs";
import { ToolRecipeStore, validateGeneratedRecipe } from "./tool-recipes.mjs";
import { EngineeringActionService } from "./engineering-actions.mjs";
import { AgentRuntime } from "./agent-runtime.mjs";
import { ApprovalService } from "./approvals.mjs";
import { ProjectService } from "./projects.mjs";
import { EvolutionService } from "./evolution.mjs";
import { GoalRunnerService } from "./goal-runner.mjs";
import { SandboxService } from "./sandbox.mjs";
import { PhysicsService } from "./physics.mjs";
import { CircuitService } from "./circuit.mjs";
import { BenchService } from "./bench.mjs";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createProfileManager({
  dataDir,
  accounts,
  legacyStateFile,
  defaultPrompt,
  baselineUpgrade,
  workspaceRoot,
  retrieveKnowledge,
  retrieveMemory,
  embedText,
  secretStore,
  ollamaUrl,
  vaultHost = null,
  projectHost = null,
  logger = null
}) {
  const profilesDir = path.join(dataDir, "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  const contexts = new Map();
  const pending = new Map();

  function initializeProfileFile(userId, profileDir, dbPath) {
    if (fs.existsSync(dbPath)) return;
    const claimedBy = accounts.getMeta("legacy_claimed_by");
    const source = accounts.getMeta("legacy_source");
    if (claimedBy !== userId || !source || !fs.existsSync(source)) return;
    fs.mkdirSync(profileDir, { recursive: true });
    const legacyBackupDir = path.join(dataDir, "backups");
    fs.mkdirSync(legacyBackupDir, { recursive: true });
    fs.copyFileSync(source, path.join(legacyBackupDir, `pre-profiles-evolv-${timestamp()}.db`));
    fs.copyFileSync(source, dbPath);
    accounts.setMeta("legacy_profile_copied", new Date().toISOString());
  }

  async function initialize(userId) {
    const user = accounts.getUser(userId);
    if (!user) throw Object.assign(new Error("Account not found."), { status: 401 });
    const profileDir = path.join(profilesDir, user.id);
    const dbPath = path.join(profileDir, "evolv.db");
    fs.mkdirSync(profileDir, { recursive: true });
    initializeProfileFile(user.id, profileDir, dbPath);
    const database = createDatabase({
      dataDir: profileDir,
      legacyStateFile: accounts.getMeta("legacy_claimed_by") === user.id ? legacyStateFile : null,
      defaultPrompt,
      baselineUpgrade,
      dbPath
    });
    // A damaged database is the one failure where the person has to be told
    // where their data went, not handed a reference number. Evolv writes a
    // daily backup beside the file for exactly this, so the message names the
    // folder rather than leaving them to find it.
    if (!database.integrityCheck()) {
      throw Object.assign(
        new Error(`Evolv's database for ${user.username} is damaged and cannot be opened. Daily backups are kept in ${database.backupsDir} — restoring the most recent one over ${dbPath} is the way back.`),
        { code: "PROFILE_DB_CORRUPT", expose: true, status: 500 }
      );
    }
    const recovered = database.reconcileAfterRestart();
    if (Object.values(recovered).some((count) => count > 0)) {
      logger?.warn("profile.startup-reconciled", { profileId: user.id, counts: recovered });
    }
    const agentRuntime = new AgentRuntime(database);
    const evolutionService = new EvolutionService(database, agentRuntime);
    const recoveredRuns = agentRuntime.recoverAbandonedRuns();
    if (recoveredRuns.paused > 0) {
      logger?.warn("profile.agent-runs-recovered", { profileId: user.id, counts: recoveredRuns });
    }
    const approvalService = new ApprovalService(database);
    const projectService = new ProjectService({
      database,
      profileId: user.id,
      profileDir,
      host: projectHost,
      // Only the migrated owner receives the historical Evolv source workspace.
      // New profiles start without filesystem access until they pick a folder.
      legacyWorkspaceRoot: user.username === "owner" ? workspaceRoot : ""
    });
    await projectService.initialize();
    const vaultService = new ObsidianVaultService({
      database,
      profileId: user.id,
      host: vaultHost,
      embedText,
      approvalService
    });
    vaultService.setProjectTaskSyncHandler(async (task) => {
      const existing = projectService.getTask(task.taskId);
      if (!existing || existing.projectId !== task.projectId) return;
      const statusMap = { active: "open", proposed: "open", resolved: "done", complete: "done", completed: "done" };
      projectService.updateTask(task.projectId, task.taskId, {
        title: task.title,
        description: task.description,
        status: ["open", "in-progress", "blocked", "done", "archived"].includes(task.status) ? task.status : (statusMap[task.status] || existing.status),
        ...(task.priority ? { priority: task.priority } : {})
      });
      database.audit("obsidian.task-synchronized", `Synchronized task ${task.taskId} from Obsidian`, {
        entityType: "project-task", entityId: task.taskId, metadata: { projectId: task.projectId }
      });
    });
    // Constructed before the engineering actions and the tool registry, both
    // of which take it as a dependency.
    const sandboxService = new SandboxService({
      database, projectService, approvalService,
      sandboxRoot: path.join(profileDir, "sandboxes")
    });
    // Memory only, and per profile so one account's scene is never another's.
    const physicsService = new PhysicsService();
    const circuitService = new CircuitService();
    // The bench drives the simulator and writes down what it did. Constructed
    // after it and given a handle to it, never the other way round: the
    // simulator must not learn about storage.
    const bench = new BenchService({ database, circuitService, physicsService });
    const engineeringActions = new EngineeringActionService({ database, workspaceRoot, approvalService, projectService, sandboxService });
    const toolRegistry = await createToolRegistry({
      workspaceRoot,
      database,
      vaultService,
      engineeringActions,
      approvalService,
      projectService,
      sandboxService,
      physicsService,
      circuitService,
      bench,
      searchKnowledge: async (query) => retrieveKnowledge(database.getState(), query),
      searchMemory: retrieveMemory
        ? async (query, context = {}) => retrieveMemory(database, query, { projectId: context.projectId })
        : async (query) => vaultService.retrieve(query)
    });
    const providerService = createProviderService({ database, secretStore, ollamaUrl });
    const toolRecipeStore = new ToolRecipeStore(database, approvalService);
    const goalRunner = new GoalRunnerService({
      database, agentRuntime, toolRegistry, providerService, vaultService, projectService
    });
    vaultService.setToolSpecHandler(async ({ path: notePath, content }) => {
      const json = String(content).match(/```json\s*([\s\S]*?)```/i)?.[1];
      if (!json) throw new Error("The Tools note does not contain a JSON recipe block.");
      const definition = validateGeneratedRecipe(JSON.parse(json), toolRegistry.builtinToolNames(), toolRegistry.list());
      const serialized = JSON.stringify(definition);
      const active = database.raw.prepare(`SELECT definition_json FROM tool_recipe_versions v
        JOIN tool_macros m ON m.id=v.macro_id WHERE m.name=? AND v.active=1`).get(definition.name);
      if (active?.definition_json === serialized) return;
      const duplicate = toolRecipeStore.listProposals(500).some((proposal) =>
        proposal.status === "pending" && JSON.stringify(proposal.definition) === serialized);
      if (duplicate) return;
      toolRecipeStore.addProposal({
        request: `Review external Obsidian Tools note edit: ${notePath}`,
        providerId: "obsidian",
        modelId: "user-edit",
        definition,
        validation: { valid: true, permissions: definition.permissions, calls: definition.steps.length, source: "obsidian-edit" }
      });
    });
    const context = {
      user: { id: user.id, username: user.username },
      database,
      toolRegistry,
      providerService,
      vaultService,
      toolRecipeStore,
      engineeringActions,
      agentRuntime,
      evolutionService,
      approvalService,
      projectService,
      goalRunner,
      sandboxService,
      physicsService,
      circuitService,
      bench
    };
    contexts.set(userId, context);
    try {
      await database.maybeDailyBackup();
    } catch (error) {
      logger?.warn("profile.daily-backup-failed", { profileId: user.id, error });
    }
    return context;
  }

  async function get(userId) {
    if (contexts.has(userId)) return contexts.get(userId);
    if (pending.has(userId)) return pending.get(userId);
    const operation = initialize(userId).finally(() => pending.delete(userId));
    pending.set(userId, operation);
    return operation;
  }

  function close() {
    for (const context of contexts.values()) {
      context.vaultService?.close();
      context.database.close();
    }
    contexts.clear();
  }

  return { get, close, profilesDir };
}
