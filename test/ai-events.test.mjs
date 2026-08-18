import test from "node:test";
import assert from "node:assert/strict";
import { assertAiEvent, collectAiEvent, createAiAccumulator, reasoningDelta, textDelta, toolCall } from "../lib/ai-events.mjs";

test("canonical AI events collect text, reasoning, and structured tool calls", () => {
  const result = createAiAccumulator();
  collectAiEvent(result, textDelta("hello "));
  collectAiEvent(result, reasoningDelta("summary"));
  collectAiEvent(result, textDelta("world"));
  collectAiEvent(result, toolCall({ id: "call_1", name: "calculate", arguments: '{"expression":"2+2"}' }));
  assert.equal(result.content, "hello world");
  assert.equal(result.reasoning, "summary");
  assert.deepEqual(result.toolCalls[0].arguments, { expression: "2+2" });
});

test("canonical AI contract rejects unknown or malformed events", () => {
  assert.throws(() => assertAiEvent({ version: 1, type: "made.up" }), /Malformed AI event/);
  assert.throws(() => toolCall({ id: "", name: "calculate", arguments: {} }), /cannot be empty/);
});
