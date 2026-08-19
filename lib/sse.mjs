export async function parseSse(response, onEvent, { warn = console.warn } = {}) {
  if (!response?.body?.getReader) throw new TypeError("Provider response is not a readable stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let warned = false;

  const emit = (block) => {
    let eventName = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    const raw = data.join("\n").trim();
    if (!raw || raw === "[DONE]") return;
    // The guard covers parsing, and nothing else.
    //
    // `onEvent` used to sit inside this try. Its catch was written for one job —
    // surviving a truncated frame — but it caught everything the callback threw
    // as well, and the adapters communicate a provider-reported failure by
    // throwing. So when OpenAI answered a request with an `error` step, its
    // explanation was swallowed here and downgraded to "malformed event", and
    // the turn went on to report that the provider's API had changed shape.
    // It had not; the reason was in the frame this line deleted.
    //
    // One malformed event still must not kill a stream. An adapter deciding the
    // stream is over must.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (!warned) warn("Skipped a malformed provider stream event.");
      warned = true;
      return;
    }
    if (eventName && parsed && typeof parsed === "object" && !Array.isArray(parsed) && !parsed._event) {
      Object.defineProperty(parsed, "_event", { value: eventName, enumerable: true });
    }
    onEvent(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) emit(block);
    if (done) break;
  }
  if (buffer.trim()) emit(buffer);
}
