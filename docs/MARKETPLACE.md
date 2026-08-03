# Evolv Marketplace Architecture

The Marketplace is a profile-isolated, offline-first subsystem inside Evolv.
It installs declarative capability packs; it never imports or evaluates pack
JavaScript, native libraries, shell scripts, or package dependencies.

## Data flow

1. `BundledMarketplaceProvider` supplies the offline catalog through the same
   provider-shaped boundary a future remote catalog can implement.
2. `MarketplaceService.preview()` validates the package, Evolv version,
   operating system, manifest, configuration schema, definitions, and
   permission difference.
3. The renderer displays every requested permission. Installation requires a
   second request containing the explicitly approved permission IDs.
4. Installation writes into a staging directory under the signed-in profile,
   atomically renames it into `marketplace-packs/<pack-id>`, and commits the
   profile SQLite registry. Failed updates restore the previous directory and
   registry record.
5. `MarketplaceService.runtime()` exposes agents, commands, and workflows only
   from healthy, enabled packs.
6. Selecting a pack command adds its validated agent and command instructions
   to one chat turn. Pack content remains subordinate to Evolv's system
   instructions and cannot expand tools or permissions.

## Persistence

Each local profile owns:

- `marketplace_installed`: version, state, approved permissions, non-secret
  configuration, manifest, health, and usage timestamps.
- `marketplace_secrets`: encrypted configuration secrets.
- `marketplace_logs`: bounded lifecycle and command-usage diagnostics.
- `marketplace_settings`: Developer Mode.
- `marketplace-packs/`: validated installed package text files.

Accounts and other profiles cannot address these records because the service is
constructed inside the existing authenticated profile context.

## Updates and security

Updates are manual. Preview compares semantic versions and permissions. New
optional permissions begin unchecked and new required permissions remain
visible in confirmation. Arduino Debugger 1.0.0 and 1.1.0 are bundled for
update testing.

- Paths are normalized, relative, non-hidden, and contain no `.` or `..`.
- Package size, text fields, and definition counts are bounded.
- Duplicate IDs, permissions, definitions, and `manifest.json` are rejected.
- Symbolic links are never accepted from the JSON package format.
- Only recognized permissions and configuration types are accepted.
- Secrets use OS secure storage and are excluded from diagnostics and exports.
- Unsupported permissions are labeled and cannot activate dormant access.
- Required permission revocation disables the pack.
- Uninstall removes only the profile pack directory, never project files.

Ratings and reviews are bundled catalog metadata, not live statistics. Payment,
remote downloads, and remote reporting are intentionally absent from v1.

