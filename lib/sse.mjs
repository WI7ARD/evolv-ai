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
    try {
      const parsed = JSON.parse(raw);
      if (eventName && parsed && typeof parsed === "object" && !Array.isArray(parsed) && !parsed._event) {
        Object.defineProperty(parsed, "_event", { value: eventName, enumerable: true });
      }
      onEvent(parsed);
    } catch {
      if (!warned) warn("Skipped a malformed provider stream event.");
      warned = true;
    }
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
