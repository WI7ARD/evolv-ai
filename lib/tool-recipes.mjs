import crypto from "node:crypto";
import { validateMacroDefinition } from "./macros.mjs";

const FORBIDDEN_KEYS = new Set([
  "url", "base_url", "command", "shell", "script", "code", "package", "executable",
  "password", "secret", "token", "api_key", "credential", "credentials"
]);

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function walk(value, visit, path = []) {
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, [...path, String(index)]));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, [...path, key]);
      walk(item, visit, [...path, key]);
    }
  }
}

export function generatedRecipeSchema() {
  return {
    type: "object",
    required: ["name", "title", "description", "inputs", "steps", "tests"],
    properties: {
      name: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      inputs: {
        type: "array", maxItems: 6, items: {
          type: "object", required: ["name", "description", "required"],
          properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } }
        }
      },
      steps: {
        type: "array", minItems: 1, maxItems: 8, items: {
          type: "object", required: ["tool", "args"],
          properties: { tool: { type: "string" }, args: { type: "object" } }
        }
      },
      tests: {
        type: "array", minItems: 1, maxItems: 8, items: {
          type: "object", required: ["name", "inputs", "expected"],
          properties: { name: { type: "string" }, inputs: { type: "object" }, expected: { type: "string" } }
        }
      }
    }
  };
}

export function validateGeneratedRecipe(raw, builtinToolNames, toolDefinitions = []) {
  const normalized = validateMacroDefinition(raw, builtinToolNames);
  const tests = (Array.isArray(raw?.tests) ? raw.tests : []).slice(0, 8).map((item) => ({
    name: String(item?.name || "").trim().slice(0, 120),
    inputs: item?.inputs && typeof item.inputs === "object" && !Array.isArray(item.inputs) ? item.inputs : {},
    expected: String(item?.expected || "").trim().slice(0, 500)
  })).filter((item) => item.name && item.expected);
  if (!tests.length) throw Object.assign(new Error("A generated tool needs at least one reviewable test case."), { status: 400 });
  const known = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const permissions = new Set();
  if (normalized.inputs.some((input) => FORBIDDEN_KEYS.has(input.name.toLowerCase()))) {
    throw Object.assign(new Error("Generated recipes cannot request passwords, API keys, tokens, or other secrets."), { status: 400 });
  }
  for (const step of normalized.steps) {
    if (step.tool.startsWith("macro_")) throw Object.assign(new Error("Generated tools cannot call other generated tools."), { status: 400 });
    const definition = known.get(step.tool);
    if (!definition) throw Object.assign(new Error(`Tool metadata is unavailable for ${step.tool}.`), { status: 400 });
    permissions.add(definition.risk || "read");
    walk(step.args, (key, value) => {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw Object.assign(new Error(`Generated recipe argument "${key}" is not permitted.`), { status: 400 });
      if (["path", "destination_path"].includes(key.toLowerCase()) && typeof value === "string" && !value.includes("{{")) {
        const normalizedPath = value.replaceAll("\\", "/");
        const segments = normalizedPath.split("/");
        if (!/^Memory\//i.test(normalizedPath) || pathIsAbsolute(normalizedPath)
          || segments.some((segment) => !segment || segment === ".." || segment.startsWith("."))) {
          throw Object.assign(new Error("Generated recipes cannot contain direct filesystem paths outside the safe Obsidian Memory folder."), { status: 400 });
        }
      }
      if (typeof value === "string" && /\b(?:powershell|cmd\.exe|node\s+-e|npm\s+install|https?:\/\/)/i.test(value)) {
        throw Object.assign(new Error("Generated recipes cannot contain commands, package installation, or arbitrary URLs."), { status: 400 });
      }
    });
  }
  return { ...normalized, tests, permissions: [...permissions].sort() };
}

function pathIsAbsolute(value) {
  return /^\/|^[A-Za-z]:\/|^\/\//.test(value);
}

export class ToolRecipeStore {
  constructor(database, approvalService = null) {
    this.database = database;
    this.approvalService = approvalService;
    // Tables come from the recorded schema in lib/schema.mjs.
  }

  #proposal(row) {
    return row ? {
      id: row.id,
      request: row.request,
      providerId: row.provider_id,
      modelId: row.model_id,
      definition: parseJson(row.definition_json, {}),
      validation: parseJson(row.validation_json, {}),
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at
    } : null;
  }

  addProposal({ request, providerId, modelId, definition, validation = {} }) {
    const id = crypto.randomUUID();
    this.database.raw.prepare(`INSERT INTO tool_recipe_proposals(id,request,provider_id,model_id,
      definition_json,validation_json,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)`)
      .run(id, String(request).slice(0, 5000), providerId, modelId, JSON.stringify(definition), JSON.stringify(validation), now());
    this.approvalService?.create({
      kind: "generated-tool-install",
      resourceType: "tool-recipe",
      resourceId: id,
      summary: `Install generated tool ${definition.name}`,
      after: { definition, validation },
      metadata: { providerId, modelId }
    });
    this.database.audit("tool-recipe.generated", `Generated tool recipe ${definition.name}`, { entityType: "tool-recipe", entityId: id, metadata: { providerId, modelId } });
    return this.getProposal(id);
  }

  getProposal(id) {
    return this.#proposal(this.database.raw.prepare("SELECT * FROM tool_recipe_proposals WHERE id=?").get(id));
  }

  listProposals(limit = 100) {
    return this.database.raw.prepare("SELECT * FROM tool_recipe_proposals ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => this.#proposal(row));
  }

  updateProposal(id, definition, validation) {
    const current = this.getProposal(id);
    if (!current || current.status !== "pending") return null;
    this.database.raw.prepare("UPDATE tool_recipe_proposals SET definition_json=?,validation_json=? WHERE id=?")
      .run(JSON.stringify(definition), JSON.stringify(validation || {}), id);
    const approval = this.approvalService?.getByResource("tool-recipe", id);
    if (approval) this.approvalService.updateEvidence(approval.id, { after: { definition, validation: validation || {} } });
    return this.getProposal(id);
  }

  decide(id, decision) {
    const proposal = this.getProposal(id);
    if (!proposal || proposal.status !== "pending") throw Object.assign(new Error("Pending generated tool not found."), { status: 404 });
    const approval = this.approvalService?.getByResource("tool-recipe", id);
    if (decision === "rejected") {
      if (approval?.status === "pending") this.approvalService.decide(approval.id, "rejected");
      this.database.raw.prepare("UPDATE tool_recipe_proposals SET status='rejected',reviewed_at=? WHERE id=?").run(now(), id);
      this.database.audit("tool-recipe.rejected", `Rejected generated tool ${proposal.definition.name}`, { entityType: "tool-recipe", entityId: id });
      return { proposal: this.getProposal(id), macro: null };
    }
    if (decision !== "approved") throw Object.assign(new Error("Decision must be approved or rejected."), { status: 400 });
    if (approval?.status === "pending") this.approvalService.decide(approval.id, "approved");
    let macro = this.database.getToolMacroByName(proposal.definition.name);
    this.database.raw.transaction(() => {
      if (!macro) {
        macro = this.database.saveToolMacro({ ...proposal.definition, status: "approved", evidence: { generatedProposalId: id } });
      } else {
        this.database.raw.prepare(`UPDATE tool_macros SET title=?,description=?,steps_json=?,inputs_json=?,
          status='approved',enabled=1,updated_at=? WHERE id=?`).run(
          proposal.definition.title, proposal.definition.description, JSON.stringify(proposal.definition.steps),
          JSON.stringify(proposal.definition.inputs), now(), macro.id
        );
        macro = this.database.getToolMacroByName(proposal.definition.name);
      }
      this.database.raw.prepare("UPDATE tool_recipe_versions SET active=0 WHERE macro_id=?").run(macro.id);
      const version = (this.database.raw.prepare("SELECT COALESCE(MAX(version),0)+1 AS value FROM tool_recipe_versions WHERE macro_id=?").get(macro.id).value);
      const serialized = JSON.stringify(proposal.definition);
      this.database.raw.prepare(`INSERT INTO tool_recipe_versions(id,macro_id,version,definition_json,definition_hash,active,created_at)
        VALUES (?,?,?,?,?,1,?)`).run(crypto.randomUUID(), macro.id, version, serialized, crypto.createHash("sha256").update(serialized).digest("hex"), now());
      this.database.raw.prepare("UPDATE tool_recipe_proposals SET status='approved',reviewed_at=? WHERE id=?").run(now(), id);
    })();
    this.database.audit("tool-recipe.approved", `Approved generated tool macro_${proposal.definition.name}`, { entityType: "tool-macro", entityId: macro.id });
    if (approval) this.approvalService.markExecuted(approval.id, { macroId: macro.id, name: macro.name });
    return { proposal: this.getProposal(id), macro: this.database.getToolMacroByName(proposal.definition.name) };
  }

  versions(macroId) {
    return this.database.raw.prepare(`SELECT id,macro_id AS macroId,version,definition_json AS definitionJson,
      definition_hash AS hash,active,created_at AS createdAt FROM tool_recipe_versions WHERE macro_id=? ORDER BY version DESC`)
      .all(macroId).map((row) => ({ ...row, definition: parseJson(row.definitionJson, {}), active: Boolean(row.active), definitionJson: undefined }));
  }

  rollback(macroId, versionId) {
    const version = this.database.raw.prepare("SELECT * FROM tool_recipe_versions WHERE id=? AND macro_id=?").get(versionId, macroId);
    if (!version) throw Object.assign(new Error("Generated tool version not found."), { status: 404 });
    const definition = parseJson(version.definition_json, {});
    this.database.raw.transaction(() => {
      this.database.raw.prepare(`UPDATE tool_macros SET title=?,description=?,steps_json=?,inputs_json=?,enabled=1,updated_at=? WHERE id=?`)
        .run(definition.title, definition.description, JSON.stringify(definition.steps), JSON.stringify(definition.inputs), now(), macroId);
      this.database.raw.prepare("UPDATE tool_recipe_versions SET active=CASE WHEN id=? THEN 1 ELSE 0 END WHERE macro_id=?").run(versionId, macroId);
    })();
    this.database.audit("tool-recipe.rolled-back", `Rolled back generated tool to version ${version.version}`, { entityType: "tool-macro", entityId: macroId });
    return { macro: this.database.listToolMacros().find((item) => item.id === macroId), versions: this.versions(macroId) };
  }
}
