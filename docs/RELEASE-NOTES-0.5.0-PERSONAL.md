# Evolv Personal 0.5.0 Release Notes

This is the private personal build. It does not modify the already-published itch.io release.

## Fixed

- Pack install approval is populated before the dialog opens, has a reliable explicit click path, prevents duplicate submissions, keeps errors visible, and verifies the installed record and enabled state before reporting success.
- The complete left sidebar is scrollable. Conversation history no longer stops at a fixed 220-pixel list, so chats and the connection footer remain reachable.

## Added

- **Load verified demo** creates an idempotent local project with two tasks and two indexed evidence notes for testing planning, citations, and honest verification.
- A Stage 7 release gate validates version alignment, UI/install contracts, documentation, itch.io manifests, automated tests, and an optional Windows package structure.
- A user guide, recovery guide, honest platform status, and reproducible release report.

## Reliability already retained

- Daily/on-demand profile backups with ten-backup retention.
- SQLite WAL, foreign keys, integrity checks, migrations, atomic pack updates, and startup reconciliation of interrupted work.
- Local account recovery, session invalidation, profile isolation, and reversible prompt/strategy history.
- Windows and Linux packaging scripts with platform-native `better-sqlite3` validation.

## Platform status

- Windows x64: built and tested on Windows for this release stage.
- Linux Mint x64: source, manifest, tests, and validator are included. The Linux binary is not verified by the Windows build and must be built and checked on Linux Mint.
- Code signing: not included; Windows SmartScreen may warn on the unsigned personal build.
