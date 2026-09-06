import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the agent is reached with /agent in chat rather than a sidebar tab", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  // No sidebar entry, but the workspace itself still exists: plans have to
  // stay reviewable before approval.
  assert.doesNotMatch(html, /data-view="agent"/);
  assert.match(html, /id="agent-view"/);
  assert.match(html, /id="agent-goal-form"/);

  // A pending approval must stay visible somewhere now that the tab is gone.
  assert.match(html, /data-view="chat"[\s\S]{0,200}id="agent-dot"/);
  // And the view needs its own way back to chat.
  assert.match(html, /id="agent-back-to-chat"/);
  assert.match(app, /agent-back-to-chat/);

  // The command is discoverable from the composer.
  // The composer hint must name the command. Matching the token rather than a
  // sentence keeps the hint free to be reworded without a false failure.
  assert.match(html.match(/id="composer-hint"[^>]*>([^<]*)</)?.[1] || "", /\/agent\b/);
  assert.match(app, /COMPOSER_COMMANDS/);
  assert.match(app, /name: "\/agent"/);
});

test("composer commands are matched locally and never sent to a model", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // Reuse the shipped matcher rather than a copy of it, so the test fails if
  // the real parsing changes.
  const source = app.match(/const COMPOSER_COMMANDS = \[[\s\S]*?\n\];[\s\S]*?function matchComposerCommand\([\s\S]*?\n\}/);
  assert.ok(source, "the composer command matcher was not found");
  const matchComposerCommand = new Function(`
    const openAgentGoal = () => {};
    ${source[0]}
    return matchComposerCommand;
  `)();

  assert.equal(matchComposerCommand("/agent")?.argument, "");
  assert.equal(matchComposerCommand("  /agent  ")?.argument, "");
  assert.equal(matchComposerCommand("/AGENT Ship the release")?.argument, "Ship the release");
  assert.equal(matchComposerCommand("/agent Audit the\nchecklist")?.argument, "Audit the\nchecklist");

  // Anything that is not a known command stays an ordinary message.
  for (const text of ["/notacommand hello", "hello /agent", "agent", "/", "//agent", ""]) {
    assert.equal(matchComposerCommand(text), null, `wrongly treated as a command: ${JSON.stringify(text)}`);
  }
});
