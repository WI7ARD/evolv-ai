import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The install panel was painted underneath the message box.
//
// #local-setup sat after #messages in normal flow. .messages reserves 190px of
// bottom padding for the fixed composer, but the panel was a *sibling* after
// that reservation, so it landed exactly where .composer-wrap — position:fixed,
// z-index:3 — is painted. The panel was present, display:grid, visibility
// visible, opacity 1, with a real 67px box, and completely invisible:
// document.elementFromPoint at its centre returned div.composer-footer.
//
// The effect was that "Get Evolv Local" could not be seen or clicked by anyone
// who already had a model — which is everyone the offer is aimed at, since the
// panel only becomes optional once Ollama has something in it. Reported as
// "there's no panel", and it took running the build to find, because every
// property a test would normally assert said the thing was fine.
test("the install panel is inside the fixed composer, not underneath it", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  const wrap = html.indexOf('<div class="composer-wrap">');
  const panel = html.indexOf('id="local-setup"');
  const messages = html.indexOf('id="messages"');

  assert.ok(wrap !== -1 && panel !== -1, "both elements still exist");
  assert.ok(panel > wrap, "the panel must live inside .composer-wrap, which owns the stacking context the composer is painted in");
  assert.ok(panel > messages, "and after the messages list it used to trail");

  // It has to be before the composer form, or it is above the fold of the wrap
  // but still under the box people type into.
  const composer = html.indexOf('id="composer"');
  assert.ok(composer === -1 || panel < composer, "the panel comes before the composer form");
});

test("the messages list still reserves room for the fixed composer", async () => {
  // The reservation is what keeps the last message clear of the composer. The
  // panel's bug was being outside it; the reservation itself is correct and
  // removing it would break something else.
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.messages\s*\{[^}]*padding:\s*38px 0 190px/);
  assert.match(css, /\.composer-wrap\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*3/);
});
