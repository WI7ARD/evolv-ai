import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("there is no goal form left to fill in", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  // The runner used to be reachable only through a command and a form that
  // asked for an objective, criteria one per line, a project, a pack, a
  // provider, a model and a budget — every one of which Evolv either knows or
  // can work out. It asked anyway, which is why almost nobody used it.
  assert.doesNotMatch(html, /id="agent-view"/);
  assert.doesNotMatch(html, /id="agent-goal-form"/);
  assert.doesNotMatch(html, /data-view="agent"/);
  assert.doesNotMatch(app, /name: "\/agent"/);
  assert.doesNotMatch(html.match(/id="composer-hint"[^>]*>([^<]*)</)?.[1] || "", /\/agent\b/);

  // A goal is now an ordinary message, so a run shows up where the answer does.
  assert.match(app, /function renderGoalProgress/);
  assert.match(app, /message\.goal \? renderGoalProgress\(message\.goal\)/);
  // A pending approval still has to be visible from chat.
  assert.match(html, /data-view="chat"[\s\S]{0,200}id="agent-dot"/);
});

test("composer commands are matched locally and never sent to a model", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // Reuse the shipped matcher rather than a copy of it, so the test fails if
  // the real parsing changes.
  const source = app.match(/const COMPOSER_COMMANDS = \[[\s\S]*?\n\];[\s\S]*?function matchComposerCommand\([\s\S]*?\n\}/);
  assert.ok(source, "the composer command matcher was not found");
  // The captured span already carries openSandbox; the view helpers it names
  // are never called here, so they need no stub.
  const matchComposerCommand = new Function(`
    ${source[0]}
    return matchComposerCommand;
  `)();

  assert.equal(matchComposerCommand("/sandbox")?.argument, "");
  assert.equal(matchComposerCommand("  /sandbox  ")?.argument, "");
  assert.equal(matchComposerCommand("/PHYSICS drop a ball")?.argument, "drop a ball");
  assert.equal(matchComposerCommand("/lab open the\ndisplay")?.argument, "open the\ndisplay");

  // Anything that is not a known command stays an ordinary message — including
  // the command that used to exist, which is now just text.
  for (const text of ["/notacommand hello", "hello /sandbox", "sandbox", "/", "//sandbox", "", "/agent do the thing"]) {
    assert.equal(matchComposerCommand(text), null, `wrongly treated as a command: ${JSON.stringify(text)}`);
  }
});

test("a message that is really work is answered as a run, in the conversation", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  // Decided inside the ordinary chat request, so there is no second entry point
  // and nothing for the person to opt into.
  assert.match(server, /goalRunner\s*\n?\s*\.fromMessage\(/);
  assert.match(server, /if \(escalation\.started\) \{/);
  // Regeneration and resume are already-answered turns; re-deciding them would
  // change what a message meant after the fact.
  assert.match(server, /if \(!regenerate && !continuation && !resumeRunId\) \{/);
  // A failure to escalate is never the person's problem: chat answers instead.
  assert.match(server, /escalation failed: \$\{error\.message\}/);
  // The run's own conversation is the one it was asked in.
  assert.match(server, /streamEscalatedGoal\(\{/);
  assert.match(server, /function goalReport\(run\)/);
});
