import test from "node:test";
import assert from "node:assert/strict";
import {
  createToolSignal,
  defineToolContract,
  dryRunToolContract,
  throwIfToolAborted
} from "../lib/tool-contracts.mjs";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

test("tool contracts reject disabled risk classes and publish typed dry-run policy", () => {
  const base = {
    name: "example_read",
    description: "Read a bounded example.",
    risk: "read",
    schema,
    validate(args) { if (typeof args?.value !== "string") throw Object.assign(new Error("value is required"), { code: "INVALID_ARGUMENT" }); },
    async execute(args) { return { value: args.value }; }
  };
  const contract = defineToolContract(base);
  const result = dryRunToolContract(contract, { value: "safe" });
  assert.equal(contract.contractVersion, 1);
  assert.equal(result.ok, true);
  assert.equal(result.effect, "local-read");
  assert.throws(() => defineToolContract({ ...base, name: "dangerous_command", risk: "command" }), /disabled risk class/);
  assert.throws(() => defineToolContract({ ...base, name: "bad", schema: { type: "string" } }), /object input schema/);
});

test("tool timeout signals cooperatively abort real work", async () => {
  const { signal } = createToolSignal(100);
  // AbortSignal.timeout() schedules an unref'd timer, so it cannot by itself
  // hold the event loop open. A real tool run always has live handles (the
  // request socket, a child process) keeping it alive; this test has none, so
  // it has to supply one or the runner exits before the abort ever fires.
  const keepAlive = setInterval(() => {}, 10);
  try {
    await assert.rejects(async () => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throwIfToolAborted(signal);
    }, (error) => error.code === "TIMEOUT" && error.name === "TimeoutError");
  } finally {
    clearInterval(keepAlive);
  }
});
