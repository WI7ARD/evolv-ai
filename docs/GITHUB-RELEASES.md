# GitHub repository, releases, and automatic updates

The intended repository is `WI7ARD/evolv-personal`. The source repository contains no profile databases, API credentials, account data, logs, exports, old builds, or smoke profiles. Large Whisper, Piper, executable, and DLL assets use Git LFS.

## First publication

1. Authenticate GitHub CLI: `gh auth login -h github.com`.
2. Create the GitHub repository with the visibility you choose. Automatic public release checks work without a token only when releases are public.
3. Review the initial staged file list carefully. Never use a blanket stage command for this workspace.
4. Commit the approved source files and push `main`.
5. Confirm the Node 20, 22, and 24 Windows CI jobs pass.

The current local GitHub credential is invalid, so repository creation and pushing must wait for authentication. No credential should be stored in this repository.

## Release process

1. Update `package.json`, `package-lock.json`, user documentation, and release notes to the same version.
2. Run `npm test` and the packaged Windows smoke tests.
3. Commit the release candidate.
4. Create and push an exact version tag such as `v0.6.3`.
5. The Windows release workflow verifies the tag, runs all tests, packages Evolv, generates the `.sha256` file, and creates the GitHub release.

The release must contain both:

- `Evolv-win32-x64-<version>.zip`
- `Evolv-win32-x64-<version>.zip.sha256`

The updater ignores drafts and prereleases. It checks at most once every six hours, shows an available update in Settings, downloads only after the user clicks **Download & install**, verifies both the release checksum and the internal packaged-file integrity manifest, then replaces the portable application folder and restarts. If the updated process exits during startup, the helper restores the previous folder.

Version 0.6.3 is the first updater-capable build, so it must be installed manually once. Later stable releases can be installed from inside Evolv.

## Remaining public-release requirement

Configure Authenticode signing before describing the build as trusted or production-ready. The current workflow intentionally publishes an unsigned personal build and documentation must continue to disclose the SmartScreen warning.
