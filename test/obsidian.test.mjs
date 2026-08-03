import test from "node:test";
import assert from "node:assert/strict";
import { extractWikilinks, vaultFilename, nodeToMarkdown, buildVaultFiles, parseVaultMarkdown } from "../lib/obsidian.mjs";

test("wikilink extraction handles aliases, headings, and duplicates", () => {
  const body = "Depends on [[Electron pin]] and [[Electron pin|the pin]], see [[Release plan#Steps]]. Not a link: [single].";
  assert.deepEqual(extractWikilinks(body), ["Electron pin", "Release plan"]);
  assert.deepEqual(extractWikilinks(""), []);
  assert.deepEqual(extractWikilinks(null), []);
});

test("vault filenames strip unsafe characters and stay unique", () => {
  const taken = new Set();
  assert.equal(vaultFilename('Ship v0.3: "final" <build>?', taken), "Ship v0.3 final build.md");
  assert.equal(vaultFilename("Same title", taken), "Same title.md");
  assert.equal(vaultFilename("Same/title", taken), "Same title 2.md");
  assert.equal(vaultFilename("///", taken), "untitled.md");
});

test("nodes round-trip through markdown with frontmatter, body, and typed links", () => {
  const node = {
    id: "n1",
    type: "task",
    title: "Ship the release",
    body: "Push to itch.io after the smoke test. Related to [[Butler setup]].",
    status: "active",
    source: "user",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  };
  const markdown = nodeToMarkdown(node, [{ relation: "depends-on", title: "Electron pin" }]);
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /type: task/);
  assert.match(markdown, /- depends-on \[\[Electron pin\]\]/);

  const parsed = parseVaultMarkdown("Ship the release.md", markdown);
  assert.equal(parsed.title, "Ship the release");
  assert.equal(parsed.type, "task");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.body, node.body, "the Related section is stripped from the stored body");
  assert.deepEqual(parsed.links, [
    { relation: "depends-on", title: "Electron pin" },
    { relation: "relates-to", title: "Butler setup" }
  ]);
});

test("plain Obsidian notes without frontmatter import as active notes", () => {
  const parsed = parseVaultMarkdown("Meeting ideas.md", "Some thoughts linking to [[Ship the release]].\n");
  assert.equal(parsed.title, "Meeting ideas");
  assert.equal(parsed.type, "note");
  assert.equal(parsed.status, "active");
  assert.deepEqual(parsed.links, [{ relation: "relates-to", title: "Ship the release" }]);
});

test("hostile frontmatter values are constrained to known types and statuses", () => {
  const markdown = "---\ntitle: Evil\ntype: superuser\nstatus: applied\n---\n\nBody text here.\n";
  const parsed = parseVaultMarkdown("evil.md", markdown);
  assert.equal(parsed.type, "note");
  assert.equal(parsed.status, "active");
});

test("vault files render edges on the from-side only", () => {
  const nodes = [
    { id: "a", type: "project", title: "Evolv", body: "", status: "active", source: "user", createdAt: "x", updatedAt: "x" },
    { id: "b", type: "decision", title: "Stay on Electron 41", body: "", status: "active", source: "user", createdAt: "x", updatedAt: "x" }
  ];
  const edges = [{ id: "e", fromId: "a", toId: "b", relation: "decided" }];
  const files = buildVaultFiles(nodes, edges);
  assert.equal(files.length, 2);
  const evolv = files.find((file) => file.name === "Evolv.md");
  const decision = files.find((file) => file.name === "Stay on Electron 41.md");
  assert.match(evolv.content, /- decided \[\[Stay on Electron 41\]\]/);
  assert.doesNotMatch(decision.content, /## Related/, "reverse direction is an Obsidian backlink, not a duplicate edge");
});
