# Evolv Personal 0.6.2 Release Notes

Evolv 0.6.2 fixes a packaged-desktop input failure associated with Marketplace dialogs.

- Marketplace permission, configuration, and starter dialogs no longer use Chromium's native modal top layer, which could leave the application keyboard-inert.
- Pack dialogs use an Evolv-owned backdrop and restore focus when closed.
- Stale Marketplace dialog state is cleared whenever the application starts.
- Pack configuration has an explicit Save click path in addition to form submission.
- Configuration saving is single-flight, reports errors in the dialog, and always restores the Save button.
- Packaged smoke coverage now inserts real keyboard text into chat, changes a pack setting, saves it, and verifies the persisted value.

Account data, installed packs, conversations, providers, projects, memory, and permissions are preserved when upgrading from 0.6.1.
