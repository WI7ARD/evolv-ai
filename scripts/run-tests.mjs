// Runs the test suite with an explicit file list.
//
// `node --test test/*.test.mjs` relies on the shell expanding the glob. POSIX
// shells do; PowerShell does not, so on Windows the literal pattern reached
// Node, and Node only learned to expand globs itself in v21 — on Node 20 the
// whole suite failed with "Could not find 'test\*.test.mjs'" and zero tests
// ran. Passing the directory instead is not equivalent either: Node treats
// every file under a directory named `test` as a test file, which would pull
// in test/helpers/.
//
// Expanding the list here keeps one behaviour on every shell and Node version.
// Extra arguments are forwarded, so `npm test -- --test-name-pattern=x` works.

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join("test", name));

if (!files.length) {
  console.error("No test files were found in test/.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...process.argv.slice(2), ...files],
  { stdio: "inherit", cwd: root }
);
child.on("error", (error) => {
  console.error(`Could not start the test runner: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
