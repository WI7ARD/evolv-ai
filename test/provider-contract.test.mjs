import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { normalizeMessagesOpenAi, toAnthropicMessages, toGeminiContents } from "../lib/providers.mjs";

// Six plumbing bugs reached people before this file existed, and every one was
// the same kind: a request shape one provider accepts and another refuses,
// found in production, reported as an index into a request nobody can see.
//
// Fixing them one at a time does not stop the seventh. What stops the seventh
// is writing down what each provider requires, generating conversations far
// nastier than a person would produce, and checking that what comes out the
// other end satisfies all three at once.

// Deterministic, so a failure names a seed that reproduces it exactly.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ["read_file", "list_dir", "physics_add_body"];

// Everything the real system can produce, including the states it produces only
// after a truncation, an interruption, or a switch of provider mid-conversation.
function conversation(next) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (probability) => next() < probability;
  const messages = [];
  if (chance(0.7)) messages.push({ role: "system", content: "you are Evolv" });

  const turns = 1 + Math.floor(next() * 6);
  for (let turn = 0; turn < turns; turn += 1) {
    if (chance(0.85)) messages.push({ role: "user", content: chance(0.1) ? "" : `ask ${turn}` });

    if (chance(0.5)) {
      // An assistant turn that calls tools. Ids are present or absent depending
      // on which provider produced it — Ollama issues none.
      const withIds = chance(0.5);
      const count = 1 + Math.floor(next() * 2);
      const calls = [];
      for (let index = 0; index < count; index += 1) {
        const name = pick(TOOLS);
        calls.push({ ...(withIds ? { id: `c${turn}_${index}` } : {}), function: { name, arguments: chance(0.1) ? "not json" : "{}" } });
      }
      messages.push({ role: "assistant", content: chance(0.5) ? `working ${turn}` : "", tool_calls: calls });
      // The answers, sometimes missing — an interrupted generation — and
      // sometimes in the wrong order.
      const answers = calls.filter(() => chance(0.75)).map((call, index) => ({
        role: "tool",
        tool_name: call.function.name,
        ...(call.id ? { tool_call_id: call.id } : {}),
        content: `result ${index}`
      }));
      if (chance(0.3)) answers.reverse();
      messages.push(...answers);
    }

    if (chance(0.7)) messages.push({ role: "assistant", content: chance(0.15) ? "" : `answer ${turn}` });
    // A stray result for a call above the window, which is what truncation
    // leaves behind.
    if (chance(0.15)) messages.push({ role: "tool", tool_call_id: "call_above_the_window", content: "orphan" });
    if (chance(0.1)) messages.push({ role: "tool", tool_name: pick(TOOLS), content: "orphan without an id" });
  }

  // The window is cut by count, so it can begin anywhere.
  return chance(0.4) ? messages.slice(Math.floor(next() * messages.length)) : messages;
}

// What each provider documents as a rejection. Written as questions about the
// finished request, because that is the only place the answer is knowable.
function checkOpenAi(messages, where) {
  const offered = new Set();
  for (const message of messages) {
    if (message.role === "assistant" && "tool_calls" in message) {
      assert.ok(message.tool_calls.length, `${where}: empty tool_calls array`);
      for (const call of message.tool_calls) {
        assert.ok(call.id, `${where}: a tool call with no id`);
        offered.add(call.id);
      }
    }
    if (message.role === "tool") {
      assert.ok(message.tool_call_id, `${where}: a tool result with no tool_call_id`);
      // Preceding, not merely present: OpenAI reads the conversation in order.
      assert.ok(offered.has(message.tool_call_id), `${where}: a tool result before the call it answers`);
    }
  }
  // Every call must be answered, or the request is incomplete.
  const answered = new Set(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  for (const id of offered) assert.ok(answered.has(id), `${where}: a tool call nobody answered`);
}

function checkAnthropic(messages, where) {
  if (!messages.length) return;
  assert.equal(messages[0].role, "user", `${where}: Anthropic requires the first message to be the user's`);
  const offered = new Set();
  for (const message of messages) {
    assert.ok(["user", "assistant"].includes(message.role), `${where}: unknown role ${message.role}`);
    assert.ok(message.content.length, `${where}: an empty content array`);
    for (const block of message.content) {
      if (block.type === "text") assert.ok(block.text, `${where}: an empty text block`);
      if (block.type === "tool_use") {
        assert.ok(block.id, `${where}: a tool_use with no id`);
        offered.add(block.id);
      }
      if (block.type === "tool_result") {
        assert.ok(block.tool_use_id, `${where}: a tool_result with no tool_use_id`);
        assert.ok(offered.has(block.tool_use_id), `${where}: a tool_result before its tool_use`);
      }
    }
  }
}

function checkGemini(contents, where) {
  let sawCall = false;
  for (const content of contents) {
    assert.ok(["user", "model"].includes(content.role), `${where}: unknown role ${content.role}`);
    assert.ok(content.parts.length, `${where}: empty parts`);
    for (const part of content.parts) {
      if (part.functionCall) sawCall = true;
      if (part.functionResponse) assert.ok(sawCall, `${where}: a functionResponse before any functionCall`);
      if ("text" in part) assert.ok(part.text, `${where}: an empty text part`);
    }
  }
}

test("every provider's rules hold for two thousand damaged conversations", () => {
  for (let seed = 1; seed <= 2000; seed += 1) {
    const next = random(seed);
    const raw = conversation(next);
    const sanitized = sanitizeConversation(raw);
    const where = `seed ${seed}`;

    checkOpenAi(normalizeMessagesOpenAi(sanitized), `${where} (OpenAI)`);
    checkAnthropic(toAnthropicMessages(sanitized), `${where} (Anthropic)`);
    checkGemini(toGeminiContents(sanitized), `${where} (Gemini)`);
  }
});

test("the rules above can actually fail", () => {
  // A test that cannot fail proves nothing, and both halves of this file are
  // capable of quietly becoming decoration: a generator that stops producing
  // damage, or checkers that stop checking. So the same conversations are put
  // through unrepaired, and most of them must be rejected.
  let rejected = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const raw = conversation(random(seed));
    try {
      checkOpenAi(normalizeMessagesOpenAi(raw), "unrepaired");
      checkAnthropic(toAnthropicMessages(raw), "unrepaired");
      checkGemini(toGeminiContents(raw), "unrepaired");
    } catch {
      rejected += 1;
    }
  }
  // Measured at 197 of 200 when this was written. The threshold is loose
  // because the point is "the damage is real", not a particular ratio.
  assert.ok(rejected > 150, `only ${rejected} of 200 unrepaired conversations were rejected`);
});

test("malformed tool arguments do not abort the request", () => {
  // The arguments are a JSON string the model wrote, so they can be nonsense. A
  // SyntaxError here would replace a reply with a stack trace.
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{not json" } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "read_file", content: "ok" }
  ];

  assert.deepEqual(toAnthropicMessages(messages)[1].content[0].input, {});
  assert.deepEqual(toGeminiContents(messages)[1].parts[0].functionCall.args, {});
});

test("a conversation nobody damaged is still delivered in full", () => {
  // The guard against a sanitiser that satisfies every rule by sending nothing.
  const healthy = [
    { role: "system", content: "you are Evolv" },
    { role: "user", content: "add a box" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "physics_add_body", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "physics_add_body", content: "{\"id\":\"b1\"}" },
    { role: "assistant", content: "Added a box." },
    { role: "user", content: "now drop it" }
  ];

  assert.deepEqual(sanitizeConversation(healthy), healthy);
  assert.equal(toAnthropicMessages(healthy).length, 5, "system is carried separately, the rest survive");
  assert.equal(toGeminiContents(healthy).length, 5);
  assert.equal(normalizeMessagesOpenAi(healthy).length, 6);
});
