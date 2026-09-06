// Models sometimes wrap otherwise-valid JSON in a Markdown fence or a short
// explanation. Accept one complete bounded JSON value without attempting to
// repair or reinterpret malformed data.
export function parseModelJson(value, { maxCharacters = 2_000_000 } = {}) {
  const source = String(value || "").replace(/^\uFEFF/, "").trim().slice(0, maxCharacters);
  if (!source) throw new SyntaxError("Model response was empty.");
  const unfenced = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(unfenced); } catch { /* scan for one JSON value */ }

  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== "{" && opener !== "[") continue;
    const stack = [opener];
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (!stack.length) {
          try { return JSON.parse(source.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  throw new SyntaxError("Model response did not contain valid JSON.");
}
