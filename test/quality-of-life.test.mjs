import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { conversationToMarkdown, safeNoteTitle, vaultNotePath } from "../lib/conversation-export.mjs";

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-qol-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "q.db"), defaultPrompt: "test" });
  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("editing a message removes it and every reply that followed", async () => {
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Beams" });
    const ids = ["a", "b", "c", "d"].map((role, index) => database.addMessage({
      conversationId: conversation.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`
    }));

    const removed = database.deleteMessagesFrom(conversation.id, ids[1]);

    assert.equal(removed, 3, "the message and both after it");
    assert.deepEqual(database.getConversation(conversation.id).messages.map((message) => message.id), [ids[0]]);
  });
});

test("messages written in the same millisecond are still cut in the right place", async () => {
  await withDatabase((database) => {
    // getConversation orders by (created_at, rowid), so a truncation that
    // compared timestamps alone would leave a later message behind or take an
    // earlier one with it.
    const conversation = database.createConversation({ title: "Fast" });
    const stamp = "2026-08-12T14:03:00.000Z";
    const ids = [0, 1, 2].map((index) => database.addMessage({
      conversationId: conversation.id, role: "user", content: `m${index}`, createdAt: stamp
    }));

    assert.equal(database.deleteMessagesFrom(conversation.id, ids[1]), 2);
    assert.deepEqual(database.getConversation(conversation.id).messages.map((message) => message.id), [ids[0]]);
  });
});

test("truncating from a message that is not there changes nothing", async () => {
  await withDatabase((database) => {
    const conversation = database.createConversation({ title: "Untouched" });
    database.addMessage({ conversationId: conversation.id, role: "user", content: "keep me" });

    assert.equal(database.deleteMessagesFrom(conversation.id, "not-a-message"), 0);
    assert.equal(database.getConversation(conversation.id).messages.length, 1);
  });
});

test("a saved chat is a readable note, not a transcript dump", () => {
  const markdown = conversationToMarkdown({
    title: "Beam deflection",
    createdAt: "2026-08-12T14:03:00Z",
    messages: [
      { role: "user", content: "What is the midspan deflection?", createdAt: "2026-08-12T14:03:10Z" },
      { role: "assistant", content: "δ = 5wL⁴/384EI", model: "evolv:latest", thinking: "internal working", createdAt: "2026-08-12T14:03:20Z" },
      { role: "tool", content: "raw tool output" },
      { role: "assistant", content: "   ", createdAt: "2026-08-12T14:03:30Z" }
    ]
  }, { now: () => "2026-08-12T15:00:00Z" });

  assert.match(markdown, /^---\ntitle: Beam deflection\n/);
  assert.match(markdown, /## You · 14:03/);
  assert.match(markdown, /## Evolv \(evolv:latest\) · 14:03/);
  assert.match(markdown, /5wL⁴\/384EI/);
  // Tool plumbing, empty turns and the reasoning trace are working notes, not
  // something anyone wants pasted into their vault.
  assert.doesNotMatch(markdown, /raw tool output/);
  assert.doesNotMatch(markdown, /internal working/);
});

test("a chat title cannot escape the vault or break Obsidian", () => {
  assert.equal(safeNoteTitle("../../etc/passwd"), "etc passwd");
  // A leading dot would make a hidden file, which the vault's path check
  // refuses — the save would fail at the last step for an invisible reason.
  assert.equal(safeNoteTitle(".hidden notes"), "hidden notes");
  assert.equal(safeNoteTitle("Notes: [[wikilink]] #tag"), "Notes wikilink tag");
  assert.equal(safeNoteTitle("   "), "Untitled chat");
  assert.equal(safeNoteTitle("x".repeat(200)).length, 80);

  const notePath = vaultNotePath({ title: "C:/beams?", createdAt: "2026-08-12T14:03:00Z" });
  assert.equal(notePath, "Evolv/Chats/2026-08-12 C beams.md");
  assert.doesNotMatch(notePath, /\.\./);
});

test("copying works where the modern clipboard API does not", async () => {
  const [app, main, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../electron/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8")
  ]);

  // Chromium asks permission to write the clipboard, and the desktop app
  // answered "no" to everything but media — which silently broke every copy
  // button, including the ones that predate this.
  assert.match(main, /clipboard-sanitized-write/);
  // Reading the clipboard is the user's other applications. Never granted.
  assert.doesNotMatch(main, /"clipboard-read"/);

  // navigator.clipboard does not exist at all outside a secure context, and
  // Evolv is a plain-HTTP server that can be opened from another machine.
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);

  // Exactly one call to the modern API, inside the helper. A second would be a
  // copy button that skips the fallback and fails where the first one worked.
  const rawCalls = app.match(/await navigator\.clipboard\.writeText/g) || [];
  assert.equal(rawCalls.length, 1, "every copy goes through the one helper");

  assert.match(server, /clipboard-write=\(self\)/);
});

test("the interface offers copy, edit, the command list, and the shortcuts", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);

  // Copy: code blocks already had this; whole messages did not.
  assert.match(app, /class="feedback-button copy-button"/);
  assert.match(app, /function copyText/);

  // Edit and resend, with the warning that it rewinds the conversation.
  assert.match(app, /class="feedback-button edit-button"/);
  assert.match(html, /id="edit-banner"/);
  assert.match(html, /sending replaces the replies after it/);
  assert.match(app, /\/truncate/);

  // Slash commands, discoverable by typing rather than by memory.
  assert.match(html, /id="command-menu"/);
  assert.match(html, /placeholder="Message Evolv…\s+\/ for commands"/);
  assert.match(app, /function renderCommandMenu/);

  // Ctrl+N, Escape, and up-arrow recall. Ctrl+K keeps its existing meaning.
  assert.match(app, /event\.key\.toLowerCase\(\) === "n"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /event\.key === "ArrowUp"/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "k"/, "the marketplace shortcut still works");

  // Saving one chat to the vault, rather than the whole database as JSON.
  assert.match(html, /id="save-chat-button"/);
  assert.match(app, /vault-note/);
});
