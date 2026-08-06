import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the sandbox is reached from chat and never offers a way to write directly", async () => {
  const [html, app, sandbox, routes] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/sandbox.js", import.meta.url), "utf8"),
    readFile(new URL("../server/sandbox-routes.mjs", import.meta.url), "utf8")
  ]);

  // Reached by command, like the agent — no sidebar entry.
  assert.doesNotMatch(html, /data-view="sandbox"/);
  assert.match(html, /id="sandbox-view"/);
  assert.match(html, /\/sandbox to review simulations/);
  assert.match(app, /name: "\/sandbox"/);
  assert.match(html, /id="sandbox-back-to-chat"/);

  // The trust message is present and tied to real session state.
  assert.match(html, /id="sandbox-banner"/);
  assert.match(sandbox, /Nothing has changed on disk/);
  assert.match(html, /id="sandbox-dot"/);

  // The critical property: no route and no button writes to the project.
  // Promotion exists only as an approval raised by propose_sandbox_promotion.
  // Checked against code with comments stripped — the module explains the
  // absence in prose, and that prose must not satisfy the assertion.
  const withoutComments = routes.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /promote/i, "no sandbox route may promote to the real project");
  assert.doesNotMatch(sandbox, /data-sandbox-action="promote"/);
});

test("sandbox routes expose only non-destructive operations", async () => {
  const routes = await readFile(new URL("../server/sandbox-routes.mjs", import.meta.url), "utf8");
  const handled = [...routes.matchAll(/req\.method === "([A-Z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(handled)].sort(), ["DELETE", "GET", "POST"]);
  // DELETE discards a simulation; it must never reach the project.
  assert.match(routes, /sandboxService\.discard/);
  assert.doesNotMatch(routes, /applyEdit\(.*real|writeFile|rename/);
});
