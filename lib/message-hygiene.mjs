// Making a conversation safe to send to any provider.
//
// Evolv keeps the last 80 messages of a conversation and sends them. That
// window is cut by count, not by meaning, so it can begin in the middle of a
// tool exchange — a result whose call is one message off the top. Every
// provider rejects that with a different sentence, all of them naming an index
// into the request rather than anything a person could find:
//
//   OpenAI     messages with role 'tool' must be a response to a preceding
//              message with 'tool_calls'
//   Anthropic  unexpected tool_use_id found in tool_result blocks
//   Gemini     function response part is missing its call
//
// The same is true of empty content. An assistant turn with no text, no images
// and no calls becomes `content: []` for Anthropic and `parts: []` for Gemini,
// and both refuse it. None of these are model problems, and all of them make a
// conversation fail permanently from whichever message first tipped the window.
//
// So the rules below hold for every provider, and are applied once, before any
// adapter sees the messages.

function hasContent(message) {
  return Boolean(String(message.content || "").trim())
    || (message.images?.length || 0) > 0
    || (message.tool_calls?.length || 0) > 0;
}

export function sanitizeConversation(messages = []) {
  const working = messages.map((message) => ({ ...message }));

  // An empty array is not "no field": OpenAI rejects `tool_calls: []` outright,
  // and every later rule reads more clearly once the field is either absent or
  // real.
  for (const message of working) {
    if (Array.isArray(message.tool_calls) && !message.tool_calls.length) delete message.tool_calls;
  }

  // Ollama issues no call ids. OpenAI requires one on both the call and its
  // answer, and Anthropic pairs tool_result to tool_use by id — so a
  // conversation held with a local model and then continued on a cloud one
  // failed on its first reply, which is precisely what rotating between models
  // does. Ids are invented here and paired, rather than each adapter sending an
  // empty string and being refused.
  for (let index = 0; index < working.length; index += 1) {
    const message = working[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    // The answers are the unbroken run of tool messages that follows.
    const answers = [];
    for (let next = index + 1; next < working.length && working[next].role === "tool"; next += 1) answers.push(working[next]);
    const taken = new Set();
    message.tool_calls = message.tool_calls.map((call, position) => {
      if (call.id) return call;
      const id = `evolv_call_${index}_${position}`;
      // By name where the tool says which it was, by position otherwise.
      const match = answers.find((answer, slot) => !taken.has(slot) && !answer.tool_call_id
          && answer.tool_name && answer.tool_name === call.function?.name)
        ?? (answers[position] && !taken.has(position) && !answers[position].tool_call_id ? answers[position] : null);
      if (match) {
        match.tool_call_id = id;
        taken.add(answers.indexOf(match));
      }
      return { ...call, id };
    });
  }

  // Which calls were actually answered, and which answers have a call. Ids are
  // how OpenAI pairs them; the Anthropic and Gemini adapters carry the same ids
  // through, and Ollama omits them entirely — so an absent id is never treated
  // as a mismatch, only a present one that pairs with nothing.
  const answeredIds = new Set(working.filter((message) => message.role === "tool" && message.tool_call_id)
    .map((message) => message.tool_call_id));
  const offeredIds = new Set(working.filter((message) => message.role === "assistant")
    .flatMap((message) => (message.tool_calls || []).map((call) => call.id).filter(Boolean)));

  const kept = [];
  for (const message of working) {
    if (message.role === "tool") {
      // A result for a call that is no longer in the window. Keeping it is a
      // 400; keeping its text as a normal message would put tool output in the
      // conversation as if the model had said it. After the pairing above, a
      // result still carrying no id is one nothing above it ever asked for.
      if (!message.tool_call_id || !offeredIds.has(message.tool_call_id)) continue;
      kept.push(message);
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      // Calls whose results never arrived — an interrupted generation, or a
      // window that ends between the call and its answer. The text is worth
      // keeping; the unanswered calls are what providers refuse.
      const answered = message.tool_calls.filter((call) => !call.id || answeredIds.has(call.id));
      if (answered.length) message.tool_calls = answered;
      else delete message.tool_calls;

      // Provider-native stateless history may contain the same function call
      // as an opaque Responses/Interactions item. If the normalized call was
      // removed above because its result never arrived, replaying the opaque
      // copy would recreate the broken half-turn at the provider boundary.
      if (Array.isArray(message.provider_state)) {
        const allowed = new Set((message.tool_calls || []).map((call) => call.id).filter(Boolean));
        message.provider_state = message.provider_state.filter((state) => {
          const item = state?.openaiItem || state?.geminiStep;
          if (!item || item.type !== "function_call") return true;
          return allowed.has(item.call_id || item.id);
        });
        if (!message.provider_state.length) delete message.provider_state;
      }
    }

    // Nothing to say and nothing to do. Sending it produces an empty content
    // array, which Anthropic and Gemini both reject.
    if (message.role !== "system" && !hasContent(message)) continue;
    kept.push(message);
  }

  // Anthropic requires the first message to be from the user, and a window that
  // opens on an assistant reply is a truncation artefact rather than a turn
  // anyone took. System messages are carried separately and stay where they
  // are.
  const first = kept.findIndex((message) => message.role !== "system");
  if (first >= 0 && kept[first].role !== "user") {
    const firstUser = kept.findIndex((message) => message.role === "user");
    if (firstUser < 0) return kept.filter((message) => message.role === "system");
    return [...kept.filter((message, index) => message.role === "system" && index < firstUser), ...kept.slice(firstUser)];
  }
  return kept;
}
