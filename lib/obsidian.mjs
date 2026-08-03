// Obsidian-style memory: [[wikilink]] parsing, markdown vault export, and
// vault import for the project memory graph. Notes are plain markdown with
// YAML frontmatter, so an exported vault opens directly in Obsidian and an
// Obsidian folder of notes imports back into memory nodes and edges.

import { MEMORY_TYPES } from "./memory.mjs";

// [[Title]], [[Title|alias]], and [[Title#heading]] all link to "Title".
const WIKILINK_PATTERN = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;
const MEMORY_STATUSES = new Set(["proposed", "active", "resolved", "archived"]);
const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

export function extractWikilinks(text) {
  const titles = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(WIKILINK_PATTERN)) {
    const title = match[1].trim();
    if (title && !seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      titles.push(title);
    }
  }
  return titles;
}

export function vaultFilename(title, taken = new Set()) {
  const base = String(title)
    .replace(INVALID_FILENAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "") || "untitled";
  let name = `${base}.md`;
  let counter = 2;
  while (taken.has(name.toLowerCase())) name = `${base} ${counter++}.md`;
  taken.add(name.toLowerCase());
  return name;
}

export function nodeToMarkdown(node, related = []) {
  const frontmatter = [
    "---",
    `id: ${node.id}`,
    `title: ${JSON.stringify(node.title)}`,
    `type: ${node.type}`,
    `status: ${node.status}`,
    `source: ${node.source}`,
    `created: ${node.createdAt}`,
    `updated: ${node.updatedAt}`,
    "---"
  ].join("\n");
  const relatedSection = related.length
    ? `\n\n## Related\n\n${related.map((edge) => `- ${edge.relation} [[${edge.title}]]`).join("\n")}`
    : "";
  return `${frontmatter}\n\n${node.body || ""}${relatedSection}\n`;
}

// Renders one .md file per node. Edges are written on their from-side only
// ("## Related"); Obsidian surfaces the other direction as a backlink, and a
// re-import does not duplicate the reverse edge.
export function buildVaultFiles(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const taken = new Set();
  return nodes.map((node) => {
    const related = edges.flatMap((edge) => {
      if (edge.fromId !== node.id) return [];
      const other = byId.get(edge.toId);
      return other ? [{ relation: edge.relation, title: other.title }] : [];
    });
    return { name: vaultFilename(node.title, taken), content: nodeToMarkdown(node, related) };
  });
}

export function parseVaultMarkdown(filename, content) {
  const text = String(content || "");
  let body = text;
  const frontmatter = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^(\w+):\s*(.*)$/);
      if (pair) frontmatter[pair[1]] = pair[2].trim();
    }
  }
  let title = frontmatter.title || String(filename).replace(/\.md$/i, "");
  if (frontmatter.title?.startsWith('"')) {
    try { title = JSON.parse(frontmatter.title); } catch { /* keep the raw value */ }
  }
  // "## Related" is regenerated from edges on export, so its typed links
  // become edges and the section is stripped from the stored body.
  const links = [];
  const relatedMatch = body.match(/(?:^|\r?\n)## Related\r?\n[\s\S]*$/);
  if (relatedMatch) {
    for (const line of relatedMatch[0].split(/\r?\n/)) {
      const edge = line.match(/^-\s*(?:([A-Za-z][\w-]{0,59})\s+)?\[\[([^\[\]|#]+)/);
      if (edge) links.push({ relation: edge[1] || "relates-to", title: edge[2].trim() });
    }
    body = body.slice(0, relatedMatch.index);
  }
  for (const inline of extractWikilinks(body)) {
    if (!links.some((link) => link.title.toLowerCase() === inline.toLowerCase())) {
      links.push({ relation: "relates-to", title: inline });
    }
  }
  const type = String(frontmatter.type || "note").toLowerCase();
  return {
    title: String(title).trim().slice(0, 200),
    type: MEMORY_TYPES.has(type) ? type : "note",
    status: MEMORY_STATUSES.has(frontmatter.status) ? frontmatter.status : "active",
    body: body.trim().slice(0, 10_000),
    links: links.slice(0, 20)
  };
}
