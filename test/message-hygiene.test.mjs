import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";

test("conversation hygiene removes unanswered provider-native calls but preserves safe output state", () => {
  const messages = sanitizeConversation([
    { role: "user", content: "Use a tool" },
    {
      role: "assistant",
      content: "I will check.",
      tool_calls: [{ id: "call_missing", function: { name: "calculate", arguments: {} } }],
      provider_state: [
        { openaiItem: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will check." }] } },
        { openaiItem: { type: "function_call", call_id: "call_missing", name: "calculate", arguments: "{}" } }
      ]
    }
  ]);
  assert.equal(messages[1].tool_calls, undefined);
  assert.equal(messages[1].provider_state.length, 1);
  assert.equal(messages[1].provider_state[0].openaiItem.type, "message");
});

test("conversation hygiene preserves provider-native calls that have a matching result", () => {
  const messages = sanitizeConversation([
    { role: "user", content: "Use a tool" },
    {
      role: "assistant",
      tool_calls: [{ id: "call_1", function: { name: "calculate", arguments: {} } }],
      provider_state: [{ geminiStep: { type: "function_call", id: "call_1", name: "calculate", arguments: {} } }]
    },
    { role: "tool", tool_name: "calculate", tool_call_id: "call_1", content: "4" }
  ]);
  assert.equal(messages[1].tool_calls[0].id, "call_1");
  assert.equal(messages[1].provider_state[0].geminiStep.id, "call_1");
  assert.equal(messages[2].tool_call_id, "call_1");
});
