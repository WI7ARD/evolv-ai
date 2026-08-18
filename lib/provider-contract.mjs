// What each provider requires of a request, in one place.
//
// These rules were learned the expensive way — six times, each as a 400 naming
// an index into a request nobody could see, on a conversation that then failed
// permanently. They are used twice: by the fuzzer, which generates thousands of
// damaged conversations and requires that none of them violate a rule, and by
// the providers themselves just before sending, so a shape nobody imagined is
// named by Evolv rather than by a provider's error code.
//
// Nothing here throws. A false positive that blocked a working request would be
// worse than the bugs it guards against, so a violation is reported and the
// request still goes — the provider remains the authority on its own API. What
// changes is that when it does refuse, Evolv can say why in a sentence.

import { imageMediaType } from "./images.mjs";

export function inspectOpenAiRequest(messages = []) {
  const problems = [];
  const offered = new Set();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && "tool_calls" in message) {
      if (!message.tool_calls?.length) problems.push(`message ${index}: an empty tool_calls array`);
      for (const call of message.tool_calls || []) {
        if (!call.id) problems.push(`message ${index}: a tool call with no id`);
        else offered.add(call.id);
      }
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) problems.push(`message ${index}: a tool result with no tool_call_id`);
      // Preceding, not merely present: OpenAI reads the conversation in order.
      else if (!offered.has(message.tool_call_id)) problems.push(`message ${index}: a tool result before the call it answers`);
    }
    // Images travel as data URLs here, and the type in the URL has to be the
    // type of the bytes.
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== "image_url") continue;
      const declared = String(part.image_url?.url || "").match(/^data:([^;]+);base64,(.*)$/s);
      if (!declared) problems.push(`message ${index}: an image that is not a base64 data URL`);
      else if (declared[1] !== imageMediaType(declared[2])) {
        problems.push(`message ${index}: an image sent as ${declared[1]} that is really ${imageMediaType(declared[2]) || "unrecognised"}`);
      }
    }
  });
  const answered = new Set(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  for (const id of offered) {
    if (!answered.has(id)) problems.push(`tool call ${id} was never answered`);
  }
  return problems;
}

export function inspectAnthropicRequest(messages = []) {
  const problems = [];
  if (!messages.length) return problems;
  if (messages[0].role !== "user") problems.push("the first message is not the user's, which Anthropic requires");
  const offered = new Set();
  messages.forEach((message, index) => {
    if (!["user", "assistant"].includes(message.role)) problems.push(`message ${index}: unknown role ${message.role}`);
    if (!message.content?.length) problems.push(`message ${index}: an empty content array`);
    for (const block of message.content || []) {
      if (block.type === "text" && !block.text) problems.push(`message ${index}: an empty text block`);
      if (block.type === "tool_use") {
        if (!block.id) problems.push(`message ${index}: a tool_use with no id`);
        else offered.add(block.id);
      }
      if (block.type === "tool_result") {
        if (!block.tool_use_id) problems.push(`message ${index}: a tool_result with no tool_use_id`);
        else if (!offered.has(block.tool_use_id)) problems.push(`message ${index}: a tool_result before its tool_use`);
      }
      if (block.type === "image") {
        // Both providers read the bytes and refuse an image that is not what it
        // was called.
        const actual = imageMediaType(block.source?.data);
        if (!actual) problems.push(`message ${index}: an image in no format Evolv accepts`);
        else if (block.source?.media_type !== actual) {
          problems.push(`message ${index}: an image sent as ${block.source?.media_type} that is really ${actual}`);
        }
      }
    }
  });
  return problems;
}

// Gemini speaks the Interactions API, whose request is a flat list of steps
// rather than contents-and-parts. The old contents-and-parts checker went with
// the builder it described: a rule that guards a code path nothing runs is
// worse than no rule, because the fuzzer keeps passing and nobody notices.
//
// Signatures are deliberately not checked here. The adapter replays each step
// exactly as the provider produced it, so a missing signature would mean the
// step itself was never captured — a different fault, in a different place, and
// one this rule could only report after the fact.
export function inspectGeminiInteractionInput(input = []) {
  const problems = [];
  const known = new Set(["user_input", "model_output", "function_call", "function_result", "reasoning"]);
  const offered = new Set();
  input.forEach((step, index) => {
    if (!step || typeof step !== "object") {
      problems.push(`step ${index}: not an object`);
      return;
    }
    if (!known.has(step.type)) problems.push(`step ${index}: unknown step type ${step.type}`);
    if (step.type === "function_call") {
      if (!step.name) problems.push(`step ${index}: a function_call with no name`);
      const id = step.call_id || step.id;
      if (!id) problems.push(`step ${index}: a function_call with no call_id`);
      else offered.add(id);
    }
    if (step.type === "function_result") {
      if (!step.call_id) problems.push(`step ${index}: a function_result with no call_id`);
      // Preceding, not merely present: the model reads its own turn in order.
      else if (!offered.has(step.call_id)) problems.push(`step ${index}: a function_result before the call it answers`);
    }
    for (const part of [...(step.content || []), ...(step.result || [])]) {
      if (part?.type === "text" && !part.text) problems.push(`step ${index}: an empty text part`);
      if (part?.type === "image") {
        const actual = imageMediaType(part.data);
        if (!actual) problems.push(`step ${index}: an image in no format Evolv accepts`);
        else if (part.mime_type !== actual) {
          problems.push(`step ${index}: an image sent as ${part.mime_type} that is really ${actual}`);
        }
      }
    }
  });
  return problems;
}

export function inspectOllamaRequest(messages = []) {
  const problems = [];
  messages.forEach((message, index) => {
    if (!["system", "user", "assistant", "tool"].includes(message.role)) {
      problems.push(`message ${index}: unknown role ${message.role}`);
    }
    // Ollama takes a plain string. The OpenAI adapter turns a message with
    // images into an array of parts, and that shape means nothing here.
    if (typeof message.content !== "string") problems.push(`message ${index}: content is not a string`);
    for (const call of message.tool_calls || []) {
      // Ollama reads arguments as an object; OpenAI hands them back as a JSON
      // string. A conversation that changed provider carries the wrong one.
      if (typeof call.function?.arguments === "string") {
        problems.push(`message ${index}: tool arguments as a string, which Ollama cannot read`);
      }
      if (!call.function?.name) problems.push(`message ${index}: a tool call with no name`);
    }
    for (const image of message.images || []) {
      if (typeof image !== "string" || !image.length) problems.push(`message ${index}: an image that is not base64 text`);
    }
  });
  return problems;
}

// Said once per request, and only when something is actually wrong. The
// provider name is included because the same conversation can be valid for one
// provider and not another, which is the whole difficulty.
export function reportRequestProblems(providerName, problems, warn = console.warn) {
  if (!problems.length) return "";
  const summary = problems.slice(0, 3).join("; ");
  warn(`Evolv built a request ${providerName} is likely to reject: ${summary}`);
  return summary;
}
