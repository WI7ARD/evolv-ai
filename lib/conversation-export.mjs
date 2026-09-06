// Turning a conversation into a note someone can actually read later.
//
// Evolv's existing export is the whole database as JSON — right for a backup,
// useless for "keep this one answer with my project notes". This produces a
// single Markdown note, which is what a vault is made of.

// A vault path is a filename on someone's disk. Anything that could climb out
// of the vault, break a filesystem, or collide with Obsidian's own syntax is
// replaced rather than escaped.
export function safeNoteTitle(title) {
  const cleaned = String(title || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    // Dot runs go too. They cannot traverse once the slashes are gone, but a
    // leading dot makes a hidden file, which the vault's own path check rejects
    // — the save would fail at the last step for a reason nobody could see.
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 80) || "Untitled chat";
}

export function vaultNotePath(conversation, { folder = "Evolv/Chats" } = {}) {
  const day = String(conversation?.createdAt || new Date().toISOString()).slice(0, 10);
  return `${folder}/${day} ${safeNoteTitle(conversation?.title)}.md`;
}

function speaker(message, fallbackModel) {
  if (message.role === "user") return "You";
  const model = message.model || fallbackModel;
  return model ? `Evolv (${model})` : "Evolv";
}

export function conversationToMarkdown(conversation, { now = () => new Date().toISOString() } = {}) {
  const title = safeNoteTitle(conversation?.title);
  const messages = (conversation?.messages || []).filter((message) =>
    (message.role === "user" || message.role === "assistant") && String(message.content || "").trim());

  const front = [
    "---",
    `title: ${title}`,
    `created: ${conversation?.createdAt || now()}`,
    `exported: ${now()}`,
    "source: Evolv",
    "---",
    ""
  ];

  const body = messages.map((message) => {
    const stamp = String(message.createdAt || "").slice(11, 16);
    const heading = `## ${speaker(message, conversation?.model)}${stamp ? ` · ${stamp}` : ""}`;
    // The reasoning trace is deliberately left out. It is a working note, not
    // an answer, and it would double the length of every export.
    return `${heading}\n\n${String(message.content).trim()}\n`;
  });

  return `${front.join("\n")}# ${title}\n\n${body.join("\n")}`;
}
