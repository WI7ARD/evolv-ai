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

// What OpenAI's Responses API requires of the `input` array Evolv builds.
//
// This is the shape that actually goes on the wire. The inspector that used to
// live here read the Chat Completions shape — role/tool_calls/tool_call_id —
// which Evolv stopped sending when it moved to /v1/responses, and it was wired
// to nothing on the OpenAI path anyway. So the one provider Evolv talks to in
// the cloud was the one provider whose requests nobody checked.
//
// The rules are the ones a Responses request fails on, and they fail the same
// way every time: "Request contains an invalid argument", or a message naming
// an index into a body the person cannot see.
export function inspectOpenAiResponsesInput(input = []) {
  const problems = [];
  if (!Array.isArray(input)) return ["the input is not an array"];
  const offered = new Set();
  const answered = new Set();
  input.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      problems.push(`item ${index}: not an object`);
      return;
    }
    // A function call and its output are matched by call_id, and OpenAI reads
    // them in order. An output whose call never appeared is the failure that
    // ends a tool round permanently, because the same history is replayed on
    // every retry.
    if (item.type === "function_call") {
      const id = item.call_id || item.id;
      if (!id) problems.push(`item ${index}: a function call with no call_id`);
      else offered.add(id);
      if (!item.name) problems.push(`item ${index}: a function call with no name`);
      if (typeof item.arguments !== "string") {
        problems.push(`item ${index}: function call arguments must be a JSON string, not ${typeof item.arguments}`);
      }
      return;
    }
    if (item.type === "function_call_output") {
      if (!item.call_id) problems.push(`item ${index}: a tool result with no call_id`);
      else if (!offered.has(item.call_id)) problems.push(`item ${index}: a tool result before the call it answers`);
      else answered.add(item.call_id);
      if (typeof item.output !== "string") problems.push(`item ${index}: a tool result whose output is not a string`);
      return;
    }
    // Everything else is a message or a replayed provider item. A message needs
    // a role and content parts of the right kind for its direction: user turns
    // carry input_text/input_image, assistant turns output_text.
    if (item.role) {
      if (!["user", "assistant", "system", "developer"].includes(item.role)) {
        problems.push(`item ${index}: unknown role ${item.role}`);
      }
      const content = Array.isArray(item.content) ? item.content : [];
      if (!content.length) problems.push(`item ${index}: an empty content array`);
      for (const part of content) {
        if (item.role === "assistant" && part.type === "input_text") {
          problems.push(`item ${index}: an assistant turn carrying input_text, which belongs to a user turn`);
        }
        if (item.role !== "assistant" && part.type === "output_text") {
          problems.push(`item ${index}: a ${item.role} turn carrying output_text, which belongs to an assistant turn`);
        }
        if (part.type === "input_image") {
          const declared = String(part.image_url || "").match(/^data:([^;]+);base64,(.*)$/s);
          if (!declared) problems.push(`item ${index}: an image that is not a base64 data URL`);
          else if (declared[1] !== imageMediaType(declared[2])) {
            problems.push(`item ${index}: an image sent as ${declared[1]} that is really ${imageMediaType(declared[2]) || "unrecognised"}`);
          }
        }
      }
    }
  });
  for (const id of offered) {
    if (!answered.has(id)) problems.push(`function call ${id} was never answered`);
  }
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
