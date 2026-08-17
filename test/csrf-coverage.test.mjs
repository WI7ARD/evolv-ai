import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Every mutating request needs the CSRF header, including the ones that cannot
// use api().
//
// api() adds x-evolv-csrf to anything that is not GET/HEAD/OPTIONS. Two places
// call fetch() directly instead, because their responses are NDJSON streams and
// api() parses JSON — a legitimate reason to bypass the helper, and an easy way
// to lose the header with it.
//
// install-evolv did lose it, and returned 403 on every click. It went unnoticed
// because the button that sends it was painted underneath the composer and
// could not be clicked at all; the cancel button beside it goes through api()
// and worked fine the whole time.
test("every direct fetch that mutates sends the CSRF header", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // Find raw fetch( calls — api() is the safe path and is not what this checks.
  const offenders = [];
  const pattern = /(?<!\.)\bfetch\(\s*(?:"([^"]+)"|`([^`]+)`)([\s\S]{0,600}?)\n\s*\}\);/g;
  let match;
  while ((match = pattern.exec(app)) !== null) {
    const url = match[1] || match[2] || "";
    const body = match[3];
    if (!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(body)) continue;
    if (!/x-evolv-csrf/.test(body)) offenders.push(url);
  }

  assert.deepEqual(offenders, [], `these mutating fetch calls send no CSRF token and will be rejected with 403: ${offenders.join(", ")}`);
});

test("the install request in particular carries the token", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = app.indexOf('fetch("/api/ollama/install-evolv"');
  assert.ok(start !== -1, "the install request still exists");
  const block = app.slice(start, start + 500);
  assert.match(block, /method:\s*"POST"/);
  assert.match(block, /x-evolv-csrf/, "install-evolv must send the CSRF token or the server answers 403");
});
