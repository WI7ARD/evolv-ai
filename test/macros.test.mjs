import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../lib/database.mjs";
import { createToolRegistry } from "../lib/tools.mjs";
import { executeMacro, mineToolSequences, resolveArgTemplate, validateMacroDefinition } from "../lib/macros.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-macros-"));
  await writeFile(path.join(root, "notes.md"), "alpha\nneedle line\nomega\n");
  const database = createDatabase({
    dataDir: path.join(root, "data"),
    legacyStateFile: path.join(root, "data", "missing.json"),
    defaultPrompt: "Test"
  });
  const registry = await createToolRegistry({
    workspaceRoot: root,
    database,
    searchKnowledge: async () => [],
    searchMemory: async () => [{ id: "m1", type: "task", title: "Remembered task", body: "From memory", score: 0.7, embedding: [1] }]
  });
  return { root, database, registry };
}

function run(conversationId, toolName, createdAt) {
  return { conversationId, toolName, status: "completed", createdAt };
}

test("sequence mining finds repeated pipelines, ignores retries and rare pairs", () => {
  const runs = [
    run("c1", "search_workspace_text", "2026-01-01T00:00:01Z"),
    run("c1", "read_workspace_text", "2026-01-01T00:00:02Z"),
    run("c2", "search_workspace_text", "2026-01-02T00:00:01Z"),
    run("c2", "read_workspace_text", "2026-01-02T00:00:02Z"),
    run("c3", "search_workspace_text", "2026-01-03T00:00:01Z"),
    run("c3", "read_workspace_text", "2026-01-03T00:00:02Z"),
    // retries of a single tool must not become a suggestion
    run("c4", "calculate", "2026-01-04T00:00:01Z"),
    run("c4", "calculate", "2026-01-04T00:00:02Z"),
    run("c4", "calculate", "2026-01-04T00:00:03Z"),
    // a pair seen only once stays below the threshold
    run("c5", "hash_text", "2026-01-05T00:00:01Z"),
    run("c5", "encode_text", "2026-01-05T00:00:02Z")
  ];
  const suggestions = mineToolSequences(runs, { minCount: 3 });
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].tools, ["search_workspace_text", "read_workspace_text"]);
  assert.equal(suggestions[0].count, 3);
  assert.equal(suggestions[0].conversations, 3);
  assert.match(suggestions[0].suggestedName, /^[a-z][a-z0-9_]{2,40}$/);
});

test("argument templates resolve safely and reject dangerous references", () => {
  const context = {
    input: { query: "needle" },
    steps: [{ tool: "calculate", ok: true, output: { result: 50, nested: { path: "notes.md" } } }]
  };
  assert.equal(resolveArgTemplate("{{input.query}}", context), "needle");
  assert.equal(resolveArgTemplate("{{steps.0.output.result}}", context), 50);
  assert.equal(resolveArgTemplate("value is {{steps.0.output.result}}!", context), "value is 50!");
  assert.deepEqual(
    resolveArgTemplate({ path: "{{steps.0.output.nested.path}}", max_lines: 5 }, context),
    { path: "notes.md", max_lines: 5 }
  );
  assert.throws(() => resolveArgTemplate("{{steps.0.output.__proto__}}", context), /Unsafe/);
  assert.throws(() => resolveArgTemplate("{{process.env}}", context), /must start with/);
  assert.throws(() => resolveArgTemplate("{{input.missing}}", context), /resolved to nothing/);
});

test("a composite recipe pauses at an approval-gated write before later steps run", async () => {
  const calls = [];
  const result = await executeMacro({
    macro: {
      inputs: [],
      steps: [
        { tool: "propose_obsidian_create", args: { path: "Memory/Test.md", content: "Review me", summary: "Test" } },
        { tool: "search_obsidian", args: { query: "should not run yet" } }
      ]
    },
    args: {},
    executeTool: async (name) => {
      calls.push(name);
      return {
        runId: "inner-run",
        ok: true,
        pendingApproval: true,
        output: JSON.stringify({ approvalRequired: true, changeId: "change-1" })
      };
    }
  });
  assert.equal(result.pendingApproval, true);
  assert.equal(result.innerRunId, "inner-run");
  assert.deepEqual(calls, ["propose_obsidian_create"]);
});

test("macro definitions are validated against built-in tools and step order", () => {
  const builtins = new Set(["calculate", "text_stats"]);
  const valid = validateMacroDefinition({
    name: "count_result",
    title: "Calculate then count",
    steps: [
      { tool: "calculate", args: { expression: "{{input.expr}}" } },
      { tool: "text_stats", args: { text: "Result: {{steps.0.output.result}}" } }
    ],
    inputs: [{ name: "expr", description: "Arithmetic expression", required: true }]
  }, builtins);
  assert.equal(valid.steps.length, 2);
  assert.throws(() => validateMacroDefinition({ name: "Bad Name!", title: "x y", steps: [{ tool: "calculate", args: {} }] }, builtins), /Macro name/);
  assert.throws(() => validateMacroDefinition({ name: "unknown_tool_macro", title: "x y", steps: [{ tool: "delete_everything", args: {} }] }, builtins), /unknown tool/);
  assert.throws(() => validateMacroDefinition({
    name: "forward_ref",
    title: "x y",
    steps: [{ tool: "calculate", args: { expression: "{{steps.1.output.result}}" } }, { tool: "calculate", args: {} }]
  }, builtins), /earlier steps/);
  assert.throws(() => validateMacroDefinition({
    name: "unknown_input",
    title: "x y",
    steps: [{ tool: "calculate", args: { expression: "{{input.nope}}" } }]
  }, builtins), /unknown input/);
});

test("approved macros execute as chained audited tools", async (t) => {
  const { root, database, registry } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.saveToolMacro({
    name: "count_result",
    title: "Calculate then count",
    description: "Calculates an expression, then measures the result text.",
    steps: [
      { tool: "calculate", args: { expression: "{{input.expr}}" } },
      { tool: "text_stats", args: { text: "The answer is {{steps.0.output.result}}" } }
    ],
    inputs: [{ name: "expr", description: "Arithmetic expression", required: true }]
  });

  const schemas = registry.schemas();
  const macroSchemaEntry = schemas.find((item) => item.function.name === "macro_count_result");
  assert.ok(macroSchemaEntry, "approved macro is offered to the model");
  assert.deepEqual(macroSchemaEntry.function.parameters.required, ["expr"]);

  const result = await registry.execute("macro_count_result", { expr: "(8+2)*5" }, { conversationId: null });
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output);
  assert.equal(payload.steps.length, 2);
  assert.equal(payload.steps[0].output.result, 50);
  assert.equal(payload.steps[1].output.words, 4);

  const runs = database.listToolRuns();
  assert.equal(runs.length, 3, "macro run plus two inner step runs are audited");
  assert.ok(runs.some((item) => item.toolName === "macro_count_result" && item.decision === "user-approved-macro"));

  // a failing step stops the chain and reports which step failed
  const failed = await registry.execute("macro_count_result", { expr: "1/0" });
  assert.equal(failed.ok, false);
  assert.match(failed.output, /Step 1 \(calculate\) failed/);
});

test("disabled and unapproved macros are not callable and not offered", async (t) => {
  const { root, database, registry } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const macro = database.saveToolMacro({
    name: "quick_math",
    title: "Quick math",
    steps: [{ tool: "calculate", args: { expression: "{{input.expr}}" } }],
    inputs: [{ name: "expr", required: true }]
  });
  database.updateToolMacro(macro.id, { enabled: false });
  assert.ok(!registry.schemas().some((item) => item.function.name === "macro_quick_math"));
  const disabled = await registry.execute("macro_quick_math", { expr: "1+1" });
  assert.match(disabled.output, /TOOL_DISABLED/);

  database.saveToolMacro({
    name: "rejected_combo",
    title: "Rejected",
    steps: [{ tool: "calculate", args: {} }],
    status: "rejected"
  });
  const rejected = await registry.execute("macro_rejected_combo", {});
  assert.match(rejected.output, /UNKNOWN_TOOL/);
});

test("search_memory tool returns memory results without embeddings", async (t) => {
  const { root, database, registry } = await fixture();
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await registry.execute("search_memory", { query: "task" });
  assert.equal(result.ok, true);
  assert.match(result.output, /Remembered task/);
  assert.doesNotMatch(result.output, /embedding/);
});
