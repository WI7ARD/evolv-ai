import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { ToolRecipeStore, validateGeneratedRecipe } from "../lib/tool-recipes.mjs";

const definitions = [
  { name: "search_obsidian", risk: "read" },
  { name: "read_obsidian_note", risk: "read" },
  { name: "propose_obsidian_edit", risk: "approval-write" }
];
const builtins = new Set(definitions.map((item) => item.name));

function recipe(name = "project_brief") {
  return {
    name,
    title: "Project brief",
    description: "Find a project note and read its most useful section.",
    inputs: [{ name: "query", description: "Project search", required: true }],
    steps: [
      { tool: "search_obsidian", args: { query: "{{input.query}}" } },
      { tool: "read_obsidian_note", args: { note_id: "{{steps.0.output.0.id}}", heading: "" } }
    ],
    tests: [{ name: "find project", inputs: { query: "alpha" }, expected: "Returns a bounded project note section." }]
  };
}

test("generated recipes accept bounded compositions and reject code, URLs, paths, nesting, and excess steps", () => {
  const valid = validateGeneratedRecipe(recipe(), builtins, definitions);
  assert.deepEqual(valid.permissions, ["read"]);
  assert.equal(valid.steps.length, 2);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("url_recipe"),
    steps: [{ tool: "search_obsidian", args: { url: "https://example.com" } }]
  }, builtins, definitions), /not permitted/);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("nested_macro"),
    steps: [{ tool: "macro_other", args: {} }]
  }, new Set([...builtins, "macro_other"]), [...definitions, { name: "macro_other", risk: "read" }]), /cannot call other/);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("private_path"),
    steps: [{ tool: "search_obsidian", args: { path: "C:/Users/Owner/secrets" } }]
  }, builtins, definitions), /direct filesystem paths/);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("traversal_path"),
    steps: [{ tool: "search_obsidian", args: { path: "Memory/../../.env" } }]
  }, builtins, definitions), /safe Obsidian Memory/);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("secret_input"),
    inputs: [
      { name: "query", description: "Project search", required: true },
      { name: "api_key", description: "Do not allow this", required: true }
    ]
  }, builtins, definitions), /cannot request passwords/);
  assert.throws(() => validateGeneratedRecipe({
    ...recipe("too_many_steps"),
    steps: Array.from({ length: 9 }, () => ({ tool: "search_obsidian", args: { query: "x" } }))
  }, builtins, definitions), /1.8 steps/);
});

test("recipe installation is explicit, versioned, replaceable, and reversible", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-recipes-"));
  const database = createDatabase({
    dataDir: root,
    legacyStateFile: path.join(root, "missing.json"),
    defaultPrompt: "Test"
  });
  const store = new ToolRecipeStore(database);
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  const firstDefinition = validateGeneratedRecipe(recipe(), builtins, definitions);
  const first = store.addProposal({
    request: "Make a project brief tool",
    providerId: "ollama",
    modelId: "test",
    definition: firstDefinition,
    validation: { valid: true, permissions: firstDefinition.permissions }
  });
  assert.equal(database.getToolMacroByName("project_brief"), null, "generation alone never installs a tool");
  const installed = store.decide(first.id, "approved");
  assert.equal(installed.macro.status, "approved");
  assert.equal(store.versions(installed.macro.id).length, 1);

  const changedRaw = recipe();
  changedRaw.description = "A reviewed replacement that also proposes an edit.";
  changedRaw.steps.push({
    tool: "propose_obsidian_edit",
    args: { note_id: "{{steps.0.output.0.id}}", content: "{{steps.1.output.body}}", summary: "Normalize the note." }
  });
  const changed = validateGeneratedRecipe(changedRaw, builtins, definitions);
  assert.deepEqual(changed.permissions, ["approval-write", "read"]);
  const second = store.addProposal({
    request: "Replace the recipe",
    providerId: "ollama",
    modelId: "test",
    definition: changed,
    validation: { valid: true, permissions: changed.permissions }
  });
  store.decide(second.id, "approved");
  const versions = store.versions(installed.macro.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].active, true);
  store.rollback(installed.macro.id, versions[1].id);
  assert.equal(store.versions(installed.macro.id).find((item) => item.id === versions[1].id).active, true);
  assert.equal(database.getToolMacroByName("project_brief").description, firstDefinition.description);
});
