import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GOAL_MINIMUM_CHARACTERS, planEarnsARun, planOnlyReads, shouldRunAsGoal
} from "../lib/goal-escalation.mjs";

const ready = { toolsEnabled: true, hasProjectFolder: true };
const decide = (text, extra = {}) => shouldRunAsGoal({ text, ...ready, ...extra });

test("a question that spans a corpus and asks for something to be established runs as a goal", () => {
  const verdict = decide("Audit every place in the codebase where we decide which model to call, and work out whether any of them can bypass the budget.");
  assert.equal(verdict.escalate, true);
  // Two independent signals, both named. The reasons are shown to the person,
  // so a run they did not ask for can at least be accounted for.
  assert.ok(verdict.reasons.length >= 2, verdict.reasons.join("; "));
});

test("ordinary conversation is never turned into a run", () => {
  // Each of these would cost a minute and several model calls to answer worse.
  for (const message of [
    "hey, how's it going today, anything I should know about",
    "thanks, that was exactly what I needed to understand the problem",
    "What is the difference between a mutex and a semaphore in practice?",
    "Write me a short release note about the provider plumbing changes",
    "Explain how the migration ledger works and why the checksums matter",
    "Summarize what we changed today in a couple of sentences for the devlog"
  ]) {
    assert.equal(decide(message).escalate, false, `escalated: ${message}`);
  }
});

test("a request phrased as work outranks its question word", () => {
  // "Why does X" is recall. "Find out why X" is work, and says so.
  assert.equal(decide("Why does the goal runner retry a step after the model fails?").escalate, false);
  assert.equal(decide("Find out why the goal runner retries a step in every place across the codebase that calls it").escalate, true);
});

test("nothing escalates when there is nothing to work over", () => {
  const work = "Audit every file across the codebase and trace where each budget check happens";
  assert.equal(decide(work).escalate, true, "the control");

  assert.equal(decide(work, { toolsEnabled: false }).escalate, false);
  assert.equal(decide(work, { hasProjectFolder: false, hasVault: false }).escalate, false);
  // A plan carries text between its steps, so nothing in one can look at an
  // attached image.
  assert.equal(decide(work, { images: [{ data: "x" }] }).escalate, false);
  assert.equal(decide(work, { mode: "creative" }).escalate, false);
  // A vault alone is a corpus too.
  assert.equal(decide(work, { hasProjectFolder: false, hasVault: true }).escalate, true);
});

test("one signal is not enough, and short messages never are", () => {
  // "every test" alone is how you would get a run out of a question a single
  // turn answers well.
  const single = decide("List every test file in the project so I can see them");
  assert.equal(single.escalate, false);
  assert.match(single.reasons[0], /only one sign/);

  assert.ok("audit every file across the repo".length < GOAL_MINIMUM_CHARACTERS);
  assert.equal(decide("audit every file across the repo").escalate, false);
});

test("a plan that only reads may start on its own; one that proposes a change may not", () => {
  const readOnlyTools = ["search_workspace_text", "read_workspace_text"];
  const reading = { steps: [
    { id: "a", type: "tool", tool: "search_workspace_text" },
    { id: "b", type: "analyze" },
    { id: "c", type: "verification" }
  ] };
  assert.equal(planOnlyReads(reading, { readOnlyTools }), true);

  const changing = { steps: [
    { id: "a", type: "tool", tool: "search_workspace_text" },
    { id: "b", type: "tool", tool: "propose_workspace_edit" },
    { id: "c", type: "verification" }
  ] };
  assert.equal(planOnlyReads(changing, { readOnlyTools }), false, "a change is the person's to approve");
  // An empty plan is not "read-only", it is not a plan.
  assert.equal(planOnlyReads({ steps: [] }, { readOnlyTools }), false);
});

test("a plan that does one thing is a chat turn wearing a plan", () => {
  // Verification and the report are scaffolding every plan has. If they are all
  // that is left once the work is removed, there was no work.
  assert.equal(planEarnsARun({ steps: [
    { id: "a", type: "project_read" },
    { id: "v", type: "verification" },
    { id: "r", type: "report" }
  ] }), false);

  assert.equal(planEarnsARun({ steps: [
    { id: "a", type: "project_search" },
    { id: "b", type: "project_read" },
    { id: "v", type: "verification" }
  ] }), true);
});

test("escalation is decided before any model is called", async () => {
  const runner = await readFile(new URL("../lib/goal-runner.mjs", import.meta.url), "utf8");

  // An ordinary question must not pay a round trip to discover it was ordinary.
  const start = runner.indexOf("wouldEscalate(");
  const end = runner.indexOf("\n  }", start);
  const body = runner.slice(start, end);
  assert.doesNotMatch(body, /#complete|streamRound/, "the cheap gate stays cheap");

  // And a run that turns out not to be worth it leaves no trace in the chat.
  assert.match(runner, /this\.agentRuntime\.cancel\(run\.id, "a single answer covers this"\)/);
  assert.match(runner, /if \(readOnly\) await this\.approve\(run\.id\)/);
});
