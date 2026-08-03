# Evolv Stage 4 - Projects, Scoped Memory, and Knowledge

## Delivered scope

Stage 4 adds a durable project domain without replacing or deleting existing conversations, memory, Obsidian notes, tools, or agent runs. SQLite schema version 8 adds projects, folder grants, tasks, project-memory scopes, conversation/run associations, indexed files, content-addressed artifacts, knowledge sources, and source chunks.

The desktop UI now has a Projects workspace and an active-project selector. A project can exist without filesystem access. Connecting a folder requires the Electron-owned native folder picker; the renderer receives only a short-lived opaque grant. Browser mode cannot submit an arbitrary path and turn it into a grant.

## Project boundary

- New profiles start with no filesystem grant.
- The migrated `owner` profile keeps the historical Evolv source workspace as a visible `legacy-workspace-migration` grant so existing personal engineering workflows are not silently broken.
- A conversation and agent run are associated with one active project.
- Workspace read and engineering proposal tools resolve their root through the stored project ID. Model-supplied paths cannot choose a new root.
- Canonical paths, symlink escapes, hidden files, secrets, dependency folders, data/backups, binaries, oversized files, and build-output folders are denied.
- Cross-profile desktop claims for the same canonical folder are rejected.
- File writes and engineering checks still use Stage 3 per-effect approvals and specialized validation.

## Tasks, artifacts, and sources

Projects include durable tasks with open, in-progress, blocked, done, and archived states. Imported files are stored once by SHA-256 under the signed-in profile's artifact directory. SQLite stores safe metadata and source associations.

Knowledge ingestion supports:

- UTF-8 text;
- Markdown chunked by headings;
- common source/config formats chunked by line ranges;
- text PDFs through a bounded built-in extractor for ordinary `Tj`/`TJ` text streams, including Flate-compressed streams;
- signature-verified PNG, JPEG, and WebP images.

Image sources are deliberately marked `metadata-only`. They are searchable from a user-provided caption and verified format/dimensions where available. Evolv does not claim OCR or visual understanding. Encrypted PDFs and PDFs with no extractable text fail explicitly; scanned PDFs require a future local OCR component.

Folder synchronization is bounded to 500 permitted files, 20 MB total, 1 MB per file, and eight directory levels. It is hash-based and idempotent. Changed sources are re-indexed, missing sources are marked deleted, and prior history is not silently rewritten.

## Retrieval and citations

Project chunks use local lexical retrieval in this stage. Search results include project ID, source ID, title, relative source path, exact heading or line locator, artifact ID, and score. Chat metadata persists these citations and the renderer shows them below the response.

Two read-only tools were added:

- `search_project_knowledge`
- `list_project_tasks`

Project source excerpts stay local for Ollama. Cloud providers receive no project excerpts unless that specific provider is enabled under **Cloud providers allowed to receive project sources**. This setting is separate from Auto-routing permission and Obsidian-vault sharing.

## Memory scopes

The `project_memory` association classifies approved memory as `working`, `project`, `long-term`, `strategy`, or `failure`. Existing SQLite memory is linked non-destructively to the default personal project through an idempotent migration receipt. New manual memory and approved memory proposals are linked to their active/default project.

When SQLite memory is authoritative, chat retrieval filters the graph to the active project. When a dedicated Obsidian vault is connected, Obsidian remains the authoritative memory source and retains its existing vault-wide retrieval semantics; automatic vault writes still require proposal approval.

## API

- `GET/POST /api/projects`
- `GET/PATCH /api/projects/:id`
- `POST /api/projects/:id/connect`
- `POST /api/projects/:id/sync`
- `GET/POST /api/projects/:id/tasks`
- `PATCH /api/projects/:id/tasks/:taskId`
- `GET /api/projects/:id/files`
- `GET /api/projects/:id/artifacts`
- `GET/POST /api/projects/:id/sources`
- `DELETE /api/projects/:id/sources/:sourceId`
- `GET /api/projects/:id/search`
- `POST /api/projects/:id/memory`

Chat accepts `projectId`, persists project metadata and citations, and links the resulting agent run.

## Portability and limits

Portable JSON exports include projects, tasks, memory associations, source records, and indexed text chunks. They exclude canonical folder paths, desktop grants, ownership claims, and binary artifact files. Imported projects must reconnect their folder and re-import binaries if those artifacts are needed.

Project embeddings, scanned-document OCR, general image understanding, binary artifact download/open controls, and PDF layout reconstruction are not claimed in Stage 4. Those remain future work.

## Verification

Tests cover migration idempotency, memory preservation, opaque grants, cross-profile claims, path filtering, project isolation, tasks, file synchronization, exact citations, real PDF text extraction, explicit scanned/encrypted PDF failure, image signature validation, metadata-only labeling, tool grant enforcement, authenticated routes, portable import/export exclusions, cloud privacy defaults, UI controls, existing streaming, approvals, Obsidian, Marketplace, providers, voice, and packaging compatibility.
