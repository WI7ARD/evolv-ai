import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = [
  "app.js", "auth.js", "sandbox.js", "physics.js", "lab.js", "demo.js",
  "demo-scripts.js", "world.js", "agent-workspace.js"
];

// Things the browser supplies. Not exhaustive by design — anything genuinely
// global and unlisted shows up as a failure, which is the right way round: a
// new global is a deliberate decision worth adding here.
const BROWSER_GLOBALS = new Set([
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
  "OffscreenCanvas", "Path2D", "DOMMatrix", "HTMLElement", "HTMLCanvasElement",
  "createImageBitmap", "speechRecognition", "SpeechRecognition", "webkitSpeechRecognition",
  // Standard library
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON",
  "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "Intl",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "globalThis", "Uint8Array",
  "Int8Array", "Uint16Array", "Uint32Array", "Float32Array", "Float64Array",
  "ArrayBuffer", "DataView", "Function", "undefined", "NaN", "Infinity", "arguments"
]);

// Every name a scope introduces: declarations, params, imports, catch bindings,
// and destructuring in any of them.
function bindingsOf(node, into) {
  if (!node) return;
  switch (node.type) {
    case "Identifier": into.add(node.name); break;
    case "ObjectPattern": for (const p of node.properties) bindingsOf(p.type === "RestElement" ? p.argument : p.value, into); break;
    case "ArrayPattern": for (const e of node.elements) bindingsOf(e, into); break;
    case "AssignmentPattern": bindingsOf(node.left, into); break;
    case "RestElement": bindingsOf(node.argument, into); break;
    default: break;
  }
}

// One flat set of every name the file introduces, not per-scope resolution.
// That under-reports — a helper declared in one function "covers" a call in
// another — and never false-positives, which is the right way round for a guard
// whose whole job is to be trusted when it fires. It still catches the bug that
// shipped, because `clearActivePack` existed nowhere in the file at all.
function declaredNames(source) {
  const tree = acorn.parse(source, { ecmaVersion: 2024, sourceType: "module", locations: true });
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "ClassDeclaration":
        if (node.id) names.add(node.id.name);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        // Both the name and the parameters. Missing the parameters of a
        // *declaration* — `export function init({ api, toast })` — was the
        // first thing this check got wrong about real code.
        if (node.id) names.add(node.id.name);
        for (const param of node.params) bindingsOf(param, names);
        break;
      case "VariableDeclarator": bindingsOf(node.id, names); break;
      case "CatchClause": bindingsOf(node.param, names); break;
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
      case "ImportSpecifier": names.add(node.local.name); break;
      default: break;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === "string") walk(child);
    }
  };
  walk(tree);
  return { tree, names };
}

// Only calls. A bare identifier can be many innocent things — a label, a
// property shorthand — but `foo()` where nothing named foo exists is always a
// bug, and it is exactly the shape a deleted function leaves behind.
function calledNames(tree) {
  const calls = [];
  const walk = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      calls.push({ name: node.callee.name, line: node.callee.loc.start.line });
    }
    // A property key or a member's property is not a reference to a binding.
    for (const key of Object.keys(node)) {
      if (parent === undefined && key === "loc") continue;
      if (node.type === "MemberExpression" && key === "property" && !node.computed) continue;
      if (node.type === "Property" && key === "key" && !node.computed) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => walk(item, node));
      else if (child && typeof child.type === "string") walk(child, node);
    }
  };
  walk(tree, undefined);
  return calls;
}

function danglingCalls(source) {
  const { tree, names } = declaredNames(source);
  return calledNames(tree)
    .filter((call) => !names.has(call.name) && !BROWSER_GLOBALS.has(call.name))
    .map((call) => `${call.name}() at line ${call.line}`);
}

for (const file of MODULES) {
  test(`public/${file} calls nothing that does not exist`, async () => {
    const source = await readFile(path.join(HERE, "..", "public", file), "utf8").catch(() => null);
    if (source === null) return; // a module removed on purpose is not a failure
    assert.deepEqual(danglingCalls(source), [], `public/${file} calls something that is not defined or imported`);
  });
}

test("the check actually catches the bug that shipped", () => {
  // The real shape: a function deleted, its call site left behind. If this
  // stops failing, the check above has stopped being worth running.
  const broken = `
    function startNewChat() {
      stopSpeech();
      clearActivePack();
    }
    function stopSpeech() {}
    startNewChat();
  `;
  assert.deepEqual(danglingCalls(broken), ["clearActivePack() at line 4"]);

  // And it does not cry wolf over ordinary code.
  const fine = `
    import { helper } from "./helper.js";
    const shout = (text) => text.toUpperCase();
    function main({ items = [] } = {}) {
      try { helper(shout(items.at(0))); } catch (error) { console.error(error); }
      setTimeout(() => main(), 10);
    }
    main();
  `;
  assert.deepEqual(danglingCalls(fine), []);
});
