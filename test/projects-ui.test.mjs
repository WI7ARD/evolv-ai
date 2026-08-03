import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Projects UI exposes scoped folder, task, source, citation, and cloud-privacy controls", async () => {
  const [html, app, preload] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8")
  ]);
  assert.match(html, /data-view="projects"/);
  assert.match(html, /id="project-select"/);
  assert.match(html, /id="project-connect-folder"/);
  assert.match(html, /id="project-source-form"/);
  assert.match(html, /Evolv does not claim OCR/);
  assert.match(html, /id="project-cloud-providers"/);
  assert.match(app, /projectId: app\.activeProjectId/);
  assert.match(app, /Project knowledge was withheld from this cloud provider/);
  assert.match(app, /arrayBufferToBase64/);
  assert.match(preload, /evolvProjects/);
  assert.doesNotMatch(preload, /readFile|writeFile|readdir|child_process/);
});
