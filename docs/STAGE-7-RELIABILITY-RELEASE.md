# Stage 7 — Reliability and Release

## Outcome

Stage 7 turns the personal workspace into a reproducible release candidate. It does not treat a green-looking screen as proof: automated tests, package structure, native-module format, manifests, and persistent data behavior are checked separately.

## Recovery

- Restart reconciliation preserves partial assistant content and marks unfinished messages, tools, routes, and evaluations honestly.
- Account recovery rotates the recovery code and invalidates every session.
- Pack installs use stage/backup/atomic rename and restore the previous version when an update fails.
- Prompt and strategy upgrades retain immutable approved history and one-click rollback.
- The recovery guide documents offline database integrity and restoration without overwriting the only copy.

## Backups and upgrades

- SQLite creates daily and on-demand profile backups with ten-backup retention.
- Legacy migrations retain timestamped originals and receipts.
- The Stage 7 test suite covers current migrations, profile isolation, backups, Marketplace installation, Linux release contracts, the demo project, and UI reliability contracts.
- `release/stage7-report.json` records exactly what the release gate checked.

## Packaging

- The Windows package contains the Electron application, Windows PE `better_sqlite3.node`, app manifest, local UI/assets, and desktop voice bridge.
- The Linux packaging script refuses to cross-build on Windows. On Linux it fetches the Linux Electron ABI module, excludes Windows-only voice binaries, emits a tarball, and validates ELF/native permissions.
- The itch.io manifests launch `Evolv.exe` on Windows and `Evolv` on Linux.

## Verification status

- Windows package: built and verified on Windows after the complete automated suite.
- Linux source/build contract: tested on Windows.
- Linux executable: not verified in this Windows stage. It must be built on Linux Mint and pass `npm run linux:validate`; claiming otherwise would be fake.
- Windows signing: not configured, so the personal archive is unsigned.

## Commands

```powershell
npm.cmd test
npm.cmd run release:stage7
$env:EVOLV_OUT_DIR = "out-stage7"
npm.cmd run dist:win
$env:EVOLV_STAGE7_PACKAGE = "$PWD\out-stage7\Evolv-win32-x64"
npm.cmd run release:stage7
```

Linux Mint:

```bash
npm install
npm test
npm run dist:linux
npm run linux:validate
```

## Acceptance

Stage 7 is complete only when the full suite passes, the release gate passes, the Windows package validates and launches, and the output hash is recorded. Linux remains separately pending until run on Linux Mint.
