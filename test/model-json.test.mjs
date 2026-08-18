import test from "node:test";
import assert from "node:assert/strict";
import { parseModelJson } from "../lib/model-json.mjs";

test("model JSON accepts exact, fenced, and briefly wrapped values without repairing malformed data", () => {
  assert.deepEqual(parseModelJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseModelJson('```json\n{"items":[1,2]}\n```'), { items: [1, 2] });
  assert.deepEqual(parseModelJson('Here is the result:\n{"text":"brace } inside a string","ok":true}\nDone.'), {
    text: "brace } inside a string", ok: true
  });
  assert.throws(() => parseModelJson('not JSON {"broken":]'), /valid JSON/i);
  assert.throws(() => parseModelJson(''), /empty/i);
});
