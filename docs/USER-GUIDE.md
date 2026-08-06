# Evolv Personal 0.6.3 User Guide

## Start and sign in

Open `Evolv.exe`. Create a local account on first launch, use a password of at least 12 characters, and save the one-time recovery code somewhere outside Evolv. Each local account has separate conversations, projects, memory, packs, provider settings, and backups.

## Chat and projects

Select a provider and model, or choose **Auto · Balanced**. Auto shows the selected provider, model, reasons, and any fallback. Cloud providers are excluded until enabled in Intelligence settings.

Use **Projects** to keep work scoped. **Load verified demo** creates a real local demo with tasks and indexed evidence; it is safe to remove like any other project. Connect a folder only when you want Evolv's bounded read tools to inspect it.

## Marketplace packs

1. Open **Marketplace** and choose a pack.
2. Select **Install**.
3. Review required and optional permissions. Required permissions cannot be unchecked; optional permissions remain your choice.
4. Select **Approve & install** once. Evolv blocks duplicate submissions and verifies the installed version is enabled before reporting success.
5. Select **Enter chat** on an installed pack and describe what you want. The pack infers a bounded task from the conversation.

If installation fails, the approval panel keeps the exact safe error visible. Close it with **Cancel**, the × button, Escape, or by selecting the backdrop. No pack can silently expand its permissions.

## Conversation sidebar

The full left sidebar now scrolls. Conversations are not capped to a small fixed box; use the sidebar scrollbar or mouse wheel to reach every chat and the connection/privacy status below them.

## Voice

Hold the microphone button while speaking and release it to transcribe and send. Whisper.cpp runs locally. Settings show the chosen model, confidence, review state, and diagnostic errors. Piper voices require the runtime, an `.onnx` model, and its matching `.onnx.json` file.

## Backups and Recovery

Open Settings and select **Create backup** before a major change. Evolv also creates daily backups and keeps the ten newest. Portable exports omit passwords, recovery hashes, API keys, private vault paths, and filesystem grants.

See [RECOVERY.md](RECOVERY.md) for account recovery, interrupted work, database checks, and rollback steps.

## Windows package

Extract the entire ZIP before launching `Evolv.exe`; do not run it from inside the ZIP. An unsigned personal build may show Windows SmartScreen. Keep `%APPDATA%\Evolv` when replacing the program folder—this is where personal data lives.

## Linux Mint

The Linux source and build path are included, but the final Linux binary must be produced on Linux Mint so the native SQLite module and executable permissions are genuine. On Linux Mint run:

```bash
npm install
npm test
npm run dist:linux
npm run linux:validate
```

Use the generated `Evolv-linux-x64-0.6.3.tar.gz`. Do not relabel a Windows build as Linux.

## Run a verified goal

1. Type `/agent` in the chat box. Adding the goal on the same line — `/agent
   audit the release checklist` — drafts it for you. The command is handled
   locally and is never sent to a model.
2. Enter the goal and one measurable success criterion per line.
3. Choose the project, optional installed pack, provider/model, and a budget no larger than the balanced preset.
4. Select **Propose plan**. Read every step. You may edit the structured plan before approval.
5. Select **Approve this plan**, then **Start approved plan**.
6. Safe local reads proceed automatically. Network research, file changes, engineering checks, and Obsidian user-note changes stop for a separate approval.
7. A run is complete only when the final verification step records evidence for the original criteria. A model answer without evidence is shown as partial or failed.

When a dedicated Obsidian vault is connected, plan approval creates a deterministic journal under `Projects/<project>/Runs/`. Evolv may append run facts to that journal only; changes to your normal notes still require a visible diff.
