# Evolv Recovery Guide

## Locked account

Use **Use recovery code** on the lock screen with the username, one-time recovery code, and a new 12+ character password. Successful recovery invalidates all sessions and rotates the code. Losing both the password and recovery code has no supported bypass.

## Interrupted response or tool run

Restart Evolv. Startup reconciliation marks unfinished assistant messages as interrupted and unfinished tool, routing, and evaluation records as failed/interrupted. It does not claim they completed. Retry from the conversation after reviewing the visible partial result.

## Provider key revoked

Open Settings → API. Delete or replace the provider credential. A provider authentication failure stays inside the provider card and does not lock or corrupt the main screen. Select Ollama or another configured provider while replacing the key.

## Database backup

Before upgrades, open Settings and select **Create backup**. Backups are profile-specific SQLite files under `%APPDATA%\Evolv\data\profiles\<profile-id>\backups`. Evolv creates daily backups and retains ten.

Do not overwrite a live database while Evolv is running. For manual recovery:

1. Close every Evolv window.
2. Copy the whole profile directory somewhere safe.
3. Work from a copy of the newest backup, never the only backup.
4. Verify it with SQLite `PRAGMA integrity_check;` and require the result `ok`.
5. Preserve the damaged database with a timestamp before replacing anything.
6. Start Evolv and verify the account, conversations, projects and settings.

Authentication lives in `accounts.db`, separate from profile conversation databases. Portable import cannot replace credentials or API keys.

## Behavioral rollback

Every approved change to how Evolv behaves is kept as immutable history. Under **Settings → Learning** you can restore an earlier version, or roll back the active one. Nothing Evolv remembers and no tool it generates becomes active without your approval.

## Release verification

Run `npm run release:stage7` from the source workspace. The gate runs the complete tests and writes `release/stage7-report.json`. A Windows package can be checked with:

```powershell
$env:EVOLV_STAGE7_PACKAGE = "C:\path\to\Evolv-win32-x64"
npm run release:stage7
```

Linux package integrity is verified separately on Linux Mint with `npm run linux:validate`.
