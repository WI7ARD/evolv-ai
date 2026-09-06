import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { callSignature, createFailureLedger, describeToolFailure, toolFailureGuidance } from "../lib/tool-feedback.mjs";

// A model given a bare tool error cannot tell "fix the arguments" from "this
// tool does not exist", so the common failure is repeating an identical call
// until the round limit — twelve rounds to reach a conclusion the first failure
// already implied.

test("the error itself comes first and unaltered", () => {
  // It is the fact. A model that reads nothing else must still see what the
  // tool said, so Evolv's reading is appended rather than substituted.
  const text = describeToolFailure(
    { function: { name: "read_workspace_text", arguments: { path: "../etc/passwd" } } },
    JSON.stringify({ error: "Path escapes the project folder.", code: "PATH_REJECTED" })
  );
  const [first] = text.split("\n");
  assert.deepEqual(JSON.parse(first), { error: "Path escapes the project folder.", code: "PATH_REJECTED" });
  assert.match(text, /\[.*path inside the project.*\]/);
});

test("a tool that cannot succeed says so instead of inviting a retry", () => {
  const disabled = describeToolFailure({ function: { name: "search_obsidian" } },
    JSON.stringify({ error: "Tool is disabled.", code: "TOOL_DISABLED" }));
  assert.match(disabled, /switched off/);
  assert.match(disabled, /will not succeed on retry/);
  assert.equal(toolFailureGuidance("TOOL_DISABLED").recoverable, false);

  // And one that can, invites exactly one informed attempt.
  assert.equal(toolFailureGuidance("INVALID_ARGUMENT").recoverable, true);
  // An unrecognised code is treated as retriable, which is the safe default:
  // one more informed attempt, rather than giving up early or looping.
  assert.equal(toolFailureGuidance("SOMETHING_NEW").recoverable, true);
});

test("the same failing call twice is told to stop, not told again", () => {
  const call = { function: { name: "list_workspace_files", arguments: { path: "/nope" } } };
  const ledger = createFailureLedger();
  const output = JSON.stringify({ error: "Not found.", code: "NOT_FOUND" });

  const first = describeToolFailure(call, output, { repeated: ledger.record(call) });
  assert.match(first, /Search or list before reading/);

  const second = describeToolFailure(call, output, { repeated: ledger.record(call) });
  assert.match(second, /attempt 2 at the identical call/);
  assert.match(second, /Do not send it again/);
  assert.doesNotMatch(second, /Search or list before reading/, "repeating advice that was ignored is not useful");
});

test("a call is the same call when its arguments mean the same thing", () => {
  // Key order is not intent, and a differing id is not a differing request.
  const a = { id: "call_1", function: { name: "read", arguments: { path: "a", depth: 2 } } };
  const b = { id: "call_2", function: { name: "read", arguments: { depth: 2, path: "a" } } };
  assert.equal(callSignature(a), callSignature(b));

  const different = { function: { name: "read", arguments: { path: "b", depth: 2 } } };
  assert.notEqual(callSignature(a), callSignature(different));
});

test("a malformed error is still handed over as something readable", () => {
  const text = describeToolFailure({ function: { name: "x" } }, "not json at all");
  assert.match(text, /not json at all/);
  assert.match(text, /\[/, "and still carries guidance");
});

test("success and approval are left exactly as they were", async () => {
  // Only failures are rewritten. A pending approval is not a failure, and a
  // cached duplicate keeps its own existing note.
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /result\.ok \|\| result\.pendingApproval\s*\n?\s*\?\s*result\.output/);
  assert.match(server, /describeToolFailure\(call, result\.output, \{ repeated: failureCount \}\)/);
});
