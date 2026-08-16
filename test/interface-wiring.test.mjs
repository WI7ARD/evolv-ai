import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// One element removed from the markup took the whole interface with it.
//
// bindEvents is a single long function of `$("#x").addEventListener(...)`. When
// a restructure removed the panel-header holding #spark-button, that one line
// threw on null and every listener registered after it never attached — so the
// sidebar stopped navigating, and nothing in the console said why. The app
// looked fine and did nothing.
//
// A missing id is a typo or a deletion, and both are worth failing a build for.
test("every element the interface reaches for without a guard actually exists", async () => {
  const [app, html] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8")
  ]);

  // `$("#x")?.` is a deliberate maybe. `$("#x").` is a promise that it is there.
  const hard = [...app.matchAll(/\$\("#([a-zA-Z0-9_-]+)"\)\.(?!\s*\?)/g)].map((match) => match[1]);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const missing = [...new Set(hard)].filter((id) => !ids.has(id));

  assert.deepEqual(missing, [], `app.js reaches for ${missing.join(", ")} without a guard, and the markup has no such element`);
});

test("the controls that survived the view collapse are still reachable", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // These three lived in the panel-headers of views that no longer exist. Each
  // moved to where it belongs rather than being dropped with its header: the
  // master tool switch leads the Tools section, the upgrade generator sits
  // beside what it generates, and "Surprise me" was never a setting — it is a
  // way to start a conversation.
  assert.match(html, /id="tools-master"/);
  assert.match(html, /data-section="learning"[\s\S]{0,400}id="propose-button"/);
  assert.match(html, /id="welcome"[\s\S]{0,900}id="spark-button"/);
});
