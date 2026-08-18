import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeConversation } from "../lib/message-hygiene.mjs";
import { normalizeMessagesOpenAi, toAnthropicMessages, toOllamaMessages } from "../lib/providers.mjs";
import { toGeminiInteractionInput } from "../lib/gemini-interactions.mjs";
import {
  inspectAnthropicRequest, inspectGeminiInteractionInput, inspectOllamaRequest, inspectOpenAiRequest, reportRequestProblems
} from "../lib/provider-contract.mjs";
import { imageMediaType } from "../lib/images.mjs";

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

// Real headers, so the type each provider is told matches the bytes it is sent.
// A screenshot is a PNG, which is the case that was broken.
const IMAGES = [
  Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]).toString("base64"),
  Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(16)]).toString("base64"),
  Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]).toString("base64"),
  Buffer.concat([Buffer.from("474946383961", "hex"), Buffer.alloc(16)]).toString("base64")
];

// Everything the real system can produce, including the states it produces only
// after a truncation, an interruption, or a switch of provider mid-conversation.
function conversation(next) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (probability) => next() < probability;
  const messages = [];
  if (chance(0.7)) messages.push({ role: "system", content: "you are Evolv" });

  const turns = 1 + Math.floor(next() * 6);
  for (let turn = 0; turn < turns; turn += 1) {
    if (chance(0.85)) {
      messages.push({
        role: "user",
        content: chance(0.1) ? "" : `ask ${turn}`,
        // An attached image, in any of the four formats Evolv accepts.
        ...(chance(0.25) ? { images: [pick(IMAGES)] } : {})
      });
    }

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

// The rules themselves live in lib/provider-contract.mjs, because the providers
// check them too — just before sending. One definition, so the fuzzer and the
// running app cannot drift into disagreeing about what "valid" means.
function refuse(problems, where) {
  assert.deepEqual(problems, [], `${where}: ${problems.join("; ")}`);
}

const checkOpenAi = (messages, where) => refuse(inspectOpenAiRequest(messages), where);
const checkAnthropic = (messages, where) => refuse(inspectAnthropicRequest(messages), where);
const checkGemini = (input, where) => refuse(inspectGeminiInteractionInput(input), where);
const checkOllama = (messages, where) => refuse(inspectOllamaRequest(messages), where);

test("every provider's rules hold for two thousand damaged conversations", () => {
  for (let seed = 1; seed <= 2000; seed += 1) {
    const next = random(seed);
    const raw = conversation(next);
    const sanitized = sanitizeConversation(raw);
    const where = `seed ${seed}`;

    checkOpenAi(normalizeMessagesOpenAi(sanitized), `${where} (OpenAI)`);
    checkAnthropic(toAnthropicMessages(sanitized), `${where} (Anthropic)`);
    checkGemini(toGeminiInteractionInput(sanitized), `${where} (Gemini)`);
    checkOllama(toOllamaMessages(sanitized), `${where} (Ollama)`);
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
      checkGemini(toGeminiInteractionInput(raw), "unrepaired");
    } catch {
      rejected += 1;
    }
  }
  // Measured at 197 of 200 when this was written. The threshold is loose
  // because the point is "the damage is real", not a particular ratio.
  assert.ok(rejected > 150, `only ${rejected} of 200 unrepaired conversations were rejected`);

  // Ollama's mapper earns its place the same way: the repaired conversation,
  // sent as it is stored, is still the wrong shape for Ollama — tool arguments
  // arrive as a JSON string from any cloud provider, and Ollama reads objects.
  let ollamaWouldReject = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    if (inspectOllamaRequest(sanitizeConversation(conversation(random(seed)))).length) ollamaWouldReject += 1;
  }
  assert.ok(ollamaWouldReject > 50, `only ${ollamaWouldReject} of 200 needed the Ollama mapping`);
});

test("the images the fuzzer generates actually reach the providers", () => {
  // An image the generator never attaches is an image rule never checked, and
  // this file would go on passing while proving nothing about images at all.
  let blocks = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const sanitized = sanitizeConversation(conversation(random(seed)));
    blocks += toAnthropicMessages(sanitized).flatMap((message) => message.content).filter((block) => block.type === "image").length;
    blocks += toGeminiInteractionInput(sanitized).flatMap((step) => step.content || []).filter((part) => part.type === "image").length;
  }
  assert.ok(blocks > 100, `only ${blocks} images reached a provider across 200 conversations`);
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

  // Gemini gets no function_call here at all: this call carries no provider
  // step, so a replay would have to invent a thought_signature and be refused.
  // What matters for this test is that the nonsense arguments still produce a
  // request rather than a SyntaxError.
  const gemini = toGeminiInteractionInput(messages);
  assert.equal(gemini.some((step) => step.type === "function_call"), false);
  assert.ok(gemini.length >= 2, "the exchange is still carried, as narration");
});

test("an attached image is described as what it actually is", () => {
  // Evolv accepts four formats and used to call all of them JPEG. Both
  // providers read the bytes and refuse an image whose declared type does not
  // match, so a screenshot — almost always a PNG — was unanswerable.
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]).toString("base64");
  const jpeg = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(16)]).toString("base64");
  const gif = Buffer.concat([Buffer.from("474946383961", "hex"), Buffer.alloc(16)]).toString("base64");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]).toString("base64");

  assert.equal(imageMediaType(png), "image/png");
  assert.equal(imageMediaType(jpeg), "image/jpeg");
  assert.equal(imageMediaType(gif), "image/gif");
  assert.equal(imageMediaType(webp), "image/webp");
  assert.equal(imageMediaType("not an image at all"), "", "and anything else is refused rather than guessed");

  const withImage = [{ role: "user", content: "what is this?", images: [png] }];
  assert.equal(toAnthropicMessages(withImage)[0].content[1].source.media_type, "image/png");
  assert.equal(toGeminiInteractionInput(withImage)[0].content[1].mime_type, "image/png");
});

test("a malformed request is named by Evolv before a provider has to refuse it", () => {
  // The runtime half of this file's rules. A shape nobody imagined still
  // reaches the provider — refusing to send would be worse than the bugs this
  // guards against — but Evolv now knows what is wrong with it.
  const orphaned = toAnthropicMessages([
    { role: "user", content: "hello" },
    { role: "tool", tool_call_id: "call_that_never_existed", content: "result" }
  ]);

  const problems = inspectAnthropicRequest(orphaned);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tool_result before its tool_use/);

  const warnings = [];
  const summary = reportRequestProblems("Anthropic", problems, (line) => warnings.push(line));
  assert.match(warnings[0], /Evolv built a request Anthropic is likely to reject/);
  assert.match(summary, /tool_result/);

  // And nothing is said when there is nothing wrong.
  assert.equal(reportRequestProblems("Anthropic", [], () => assert.fail("said something")), "");
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
  assert.equal(toGeminiInteractionInput(healthy).length, 5);
  assert.equal(normalizeMessagesOpenAi(healthy).length, 6);
});
