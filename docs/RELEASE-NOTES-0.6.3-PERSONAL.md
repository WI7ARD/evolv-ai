# Evolv Personal 0.6.3 Release Notes

Evolv 0.6.3 fixes the pack configuration layout shown in the August 2 screenshot and introduces the first GitHub update-capable desktop build.

## Fixed

- Pack fields now scroll inside a bounded area while Reset, Cancel, and Save remain pinned and visible at short desktop window heights.
- Marketplace dialogs remain outside Chromium's keyboard-inert native modal layer.
- Stale Marketplace dialog state is cleared at startup, and pack configuration retains its explicit Save click path.

## GitHub updates

- Settings includes **Software updates** with Check and Download & install controls.
- Update checks use the stable `WI7ARD/evolv-personal` GitHub release and never download silently.
- Downloads require exact versioned ZIP and SHA-256 assets.
- Redirects outside trusted GitHub hosts, drafts, prereleases, malformed versions, checksum mismatches, and invalid internal integrity manifests are rejected.
- Installation replaces the portable application folder only after the app exits, restarts Evolv, and restores the previous folder if the updated process exits during startup.
- GitHub Actions run the Windows test matrix and produce release ZIP/checksum assets from version tags.
- Private data, API credentials, logs, old builds, and smoke profiles are excluded from Git. Large voice/runtime assets are configured for Git LFS.

This is still an unsigned personal Windows build. Authenticode signing remains required before calling it a trusted public production release.
