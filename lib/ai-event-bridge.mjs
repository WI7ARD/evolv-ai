// Canonical AI events, spoken as Evolv's chat loop expects to hear them.
//
// The OpenAI Responses and Gemini Interactions adapters emit a typed event
// vocabulary — text.delta, reasoning.delta, tool.call, provider.state, usage,
// finish — while server.mjs and goal-runner.mjs read the older shape,
// `{ message: { content, thinking, tool_calls } }`. Translating once, here, is
// what lets the better adapters land without rewriting the chat loop and the
// goal runner around them.
//
// The reason to keep the adapters' vocabulary rather than have them emit the
// old shape directly: `tool.call` carries `providerState`, the provider's own
// representation of the call. Replaying that verbatim is what makes tool calls
// survive a second round — Gemini refuses a replayed call whose thoughtSignature
// is missing, and there is no reason to believe it is the last field a provider
// will require back. Extracting known fields one at a time is how that class of
// bug keeps recurring; handing the provider its own step back does not.

import { assertAiEvent } from "./ai-events.mjs";

// Events that carry no text and no call still matter to the caller: usage and
// finish end a round. They are passed through in the old shape's terms so the
// loop's existing handling of `done` and `done_reason` keeps working.
export function toLegacyChunk(event) {
  assertAiEvent(event);
  switch (event.type) {
    case "text.delta":
      return { message: { content: event.delta } };
    case "reasoning.delta":
      return { message: { thinking: event.delta } };
    case "tool.call":
      return {
        message: {
          tool_calls: [{
            id: event.id,
            type: "function",
            function: { name: event.name, arguments: event.arguments },
            // The provider's own step, kept whole. Nothing here reads it; the
            // adapter that produced it is the only thing that understands it.
            ...(event.providerState ? { providerState: event.providerState } : {})
          }]
        }
      };
    case "usage":
      return { usage: event.usage };
    case "finish":
      return { done: true, done_reason: event.reason };
    // provider.state describes the assistant turn rather than one call. The
    // chat loop has nowhere to put it today, so it is dropped rather than
    // invented into a shape that would be silently discarded downstream. Tool
    // calls carry their own state and are the case that actually has to
    // round-trip.
    case "provider.state":
    case "fallback":
    default:
      return null;
  }
}

// Wraps a legacy-shaped onChunk so an adapter that speaks canonical events can
// be handed straight to it.
export function bridgeToLegacy(onChunk) {
  return (event) => {
    const chunk = toLegacyChunk(event);
    if (chunk) onChunk(chunk);
  };
}
