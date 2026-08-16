import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deleting a function and leaving a call to it behind.
//
// This shipped. Removing the pack system took out `clearActivePack`, and
// `startNewChat` still called it on its first line — so "New conversation"
// threw ReferenceError before it created anything, and the app could not open a
// new chat at all. The whole test suite passed, because nothing in it opens a
// chat in a browser.
//
// `node --check` cannot catch this: a free identifier is perfectly legal
// JavaScript until the line runs. That is the second time in this codebase a
// deletion left a dangling reference that only a real click would find, so it
// is worth a static check rather than a resolution to be more careful.
//
// The renderer has no build step and no type checker, which is a deliberate
// security property — no bundler, no transform between what is written and what
// runs. The cost is that nothing else is watching for this.
//
// No parser, deliberately. The first version of this file imported acorn as a
// development dependency and broke CI on all three Node versions, because the
// Linux test jobs run `npm ci --omit=dev` on purpose — Electron's postinstall
// hangs on Node >=24 there — and the workflow says in as many words that the
// tests need no development dependency. A test that guards against breakage is
// worth little if adding it breaks the build.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = [
  "app.js", "auth.js", "sandbox.js", "physics.js", "lab.js", "demo.js",
  "demo-scripts.js", "world.js", "agent-workspace.js"
];

// Things the browser supplies. Not exhaustive by design — anything genuinely
// global and unlisted shows up as a failure, which is the right way round: a
// new global is a deliberate decision worth recording here.
const GLOBALS = new Set([
  "window", "document", "console", "navigator", "location", "history", "screen",
  "localStorage", "sessionStorage", "fetch", "URL", "URLSearchParams", "Blob", "File",
  "FileReader", "FormData", "Headers", "Request", "Response", "AbortController",
  "AbortSignal", "Event", "CustomEvent", "EventTarget", "MutationObserver",
  "ResizeObserver", "IntersectionObserver", "Image", "Audio", "Option", "DOMParser",
  "TextEncoder", "TextDecoder", "WebSocket", "Worker", "crypto", "performance",
  "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "queueMicrotask", "structuredClone", "matchMedia",
  "getComputedStyle", "alert", "confirm", "prompt", "atob", "btoa", "speechSynthesis",
  "SpeechSynthesisUtterance", "MediaRecorder", "AudioContext", "webkitAudioContext",
  "OffscreenCanvas", "Path2D", "DOMMatrix", "createImageBitmap", "SpeechRecognition",
  "webkitSpeechRecognition", "import", "super", "this",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "Intl",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "globalThis", "Uint8Array",
  "Int8Array", "Int16Array", "Uint16Array", "Uint32Array", "Uint8ClampedArray",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "ArrayBuffer", "DataView", "Function", "undefined", "NaN", "Infinity", "arguments"
]);

// Keywords that are followed by `(` and are not calls.
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof", "in",
  "of", "new", "delete", "void", "await", "yield", "function", "class", "const",
  "let", "var", "else", "do", "try", "finally", "throw", "case", "default",
  "break", "continue", "export", "from", "as", "async", "static", "get", "set",
  "extends", "with", "debugger"
]);

// Comments, strings, template literals and regex literals become spaces, so
// offsets and line numbers survive and no identifier inside a string is ever
// mistaken for code. A character scanner rather than a regex, because the cases
// that break regexes here — a quote inside a comment, a slash inside a string —
// are exactly the ones that would make this untrustworthy.
function blankNonCode(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  // Whether a `/` here starts a regex or is division, decided by the previous
  // significant character.
  let previous = "";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      let j = i; while (j < source.length && source[j] !== "\n") j += 1;
      blank(i, j); i = j; continue;
    }
    if (c === "/" && next === "*") {
      const j = source.indexOf("*/", i + 2);
      const end = j === -1 ? source.length : j + 2;
      blank(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) { if (source[j] === "\\") j += 1; j += 1; }
      blank(i, j + 1); i = j + 1; previous = "s"; continue;
    }
    if (c === "`") {
      // Template literals nest code inside ${...}; only the literal text is
      // blanked, because an interpolation is real code that may contain calls.
      let j = i + 1;
      out[i] = " ";
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\") { out[j] = " "; out[j + 1] = out[j + 1] === "\n" ? "\n" : " "; j += 2; continue; }
        if (source[j] === "$" && source[j + 1] === "{") {
          let depth = 1; j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth += 1;
            else if (source[j] === "}") depth -= 1;
            j += 1;
          }
          continue;
        }
        if (out[j] !== "\n") out[j] = " ";
        j += 1;
      }
      if (j < source.length) out[j] = " ";
      i = j + 1; previous = "s"; continue;
    }
    if (c === "/" && !/[A-Za-z0-9_$)\]]/.test(previous)) {
      let j = i + 1; let inClass = false;
      while (j < source.length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        else if (source[j] === "\n") break;
        j += 1;
      }
      blank(i, j + 1); i = j + 1; previous = "s"; continue;
    }
    if (!/\s/.test(c)) previous = c;
    i += 1;
  }
  return out.join("");
}

// The rule: a name that is *called* and appears nowhere else in the file, in
// any position other than a call, is a call to something that does not exist.
//
// Deliberately generous about what counts as "appears" — a declaration, a
// parameter, an import, a bare mention, an object key. That under-reports, and
// never false-positives, which is the right way round for a check whose value
// is being trusted when it fires. It still catches the bug that shipped,
// because `clearActivePack` appeared in the file only as a call.
export function danglingCalls(source) {
  const code = blankNonCode(source);
  // Precomputed newline offsets. Slicing the whole prefix per match made this
  // quadratic, and app.js alone took 2.4 seconds of the suite.
  const newlines = [];
  for (let i = 0; i < code.length; i += 1) if (code[i] === "\n") newlines.push(i);
  const lineOf = (index) => {
    let low = 0; let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (newlines[mid] < index) low = mid + 1; else high = mid;
    }
    return low + 1;
  };
  const mentioned = new Set();
  const calls = [];
  // Where the balanced `(` ... `)` starting at `from` ends. Used to tell a
  // definition from a call: `name(args) {` defines, `name(args)` calls.
  const afterArguments = (from) => {
    let depth = 0;
    for (let i = from; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") { depth -= 1; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = identifier.exec(code)) !== null) {
    const name = match[0];
    const start = match.index;
    // Bounded windows, not whole-prefix slices: those were the other half of
    // the quadratic cost, and nothing either test looks at is more than a few
    // characters away.
    const before = code.slice(Math.max(0, start - 24), start);
    const rest = code.slice(start + name.length, start + name.length + 64);
    if (/[.?]\s*$/.test(before)) continue;               // a property, not a binding
    if (!/^\s*\(/.test(rest) || KEYWORDS.has(name)) { mentioned.add(name); continue; }

    // `function name(` and `class name(` declare rather than call. Missing this
    // was the first thing this check got wrong: it flagged every function in
    // the file as a call to something that does not exist.
    if (/\b(?:function|class)\s*\*?\s*$/.test(before)) { mentioned.add(name); continue; }

    // Method shorthand and accessors: `name(args) {` is a definition, while
    // `name(args)` anywhere else is a call.
    const close = afterArguments(start + name.length + rest.indexOf("("));
    if (close !== -1 && /^\s*\{/.test(code.slice(close))) { mentioned.add(name); continue; }

    calls.push({ name, line: lineOf(start) });
  }
  return calls
    .filter((call) => !mentioned.has(call.name) && !GLOBALS.has(call.name) && !KEYWORDS.has(call.name))
    .map((call) => `${call.name}() at line ${call.line}`);
}

for (const file of MODULES) {
  test(`public/${file} calls nothing that does not exist`, async () => {
    const source = await readFile(path.join(HERE, "..", "public", file), "utf8").catch(() => null);
    if (source === null) return; // a module removed on purpose is not a failure
    assert.deepEqual(danglingCalls(source), [], `public/${file} calls something that is not defined or imported`);
  });
}

test("the check catches the shape of the bug that shipped", () => {
  const broken = `
    function startNewChat() {
      stopSpeech();
      clearActivePack();
    }
    function stopSpeech() {}
    startNewChat();
  `;
  assert.deepEqual(danglingCalls(broken), ["clearActivePack() at line 4"]);
});

test("the check does not cry wolf over ordinary code", () => {
  const fine = `
    import { helper } from "./helper.js";
    import fallback from "./fallback.js";
    const shout = (text) => text.toUpperCase();
    export function main({ items = [], onDone = fallback } = {}) {
      const pattern = /clearActivePack\\(/;      // a call inside a regex
      const note = "call clearEverything() now"; // and inside a string
      if (pattern.test(note)) helper(shout(items.at(0)));
      try { onDone(); } catch (error) { console.error(error); }
      setTimeout(() => main(), 10);
    }
    main();
  `;
  assert.deepEqual(danglingCalls(fine), []);
});

test("a call written only inside a string or comment is not code", () => {
  // The blanking pass is what makes the generous rule safe: without it, the
  // word in a comment would excuse a real dangling call elsewhere.
  const source = `
    // remember to call ghost()
    const label = "ghost()";
    ghost();
  `;
  assert.deepEqual(danglingCalls(source), ["ghost() at line 4"]);
});
