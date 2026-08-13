# Evolv Personal 0.6.4

## Updates no longer cost a full download

The Linux AppImage updates itself from the copy already installed, fetching
only the blocks that differ. Most of the image is Electron and does not change
between releases, so an update is normally a few megabytes rather than three
hundred. The assembled image must match the release's published SHA-256 before
anything is replaced, and the previous image is kept beside the new one until
Evolv has started successfully once.

This is the first release to publish the block map that makes that possible, so
the saving applies from the *next* release onwards; installing 0.6.4 itself is
still a full download.

The updater also checked the wrong repository. Releases are published to
`WI7ARD/evolv-ai`; the updater looked in `WI7ARD/evolv-personal` and would have
reported "no stable release is available" no matter how many existed. The
repository is now read from `package.json`, so it cannot drift from the one the
release workflow publishes to.

## Choosing a model

- **Favourites.** The star beside the model list pins a model to a Favourites
  group at the top. Favourites are per provider.
- **Memory warnings.** A local model larger than this computer's memory is
  labelled before it is chosen, rather than failing several seconds into a reply
  with an error about memory that names no fix.
- **Models that failed are remembered.** Two consecutive failures caused by the
  model itself put the reason in the list, and Auto routes around it. Any
  successful reply clears the record. Failures that are not the model's fault —
  Ollama shut down, a rejected key, a rate limit — are never counted against it.

## Everyday things that were missing

- Copy any message, not just code blocks. Copying also works again in the
  desktop app, where the window's permission rules had been refusing it, and now
  falls back to an older method where the browser's clipboard API is
  unavailable.
- Edit and resend one of your own messages. Sending rewinds the conversation to
  that point; nothing is deleted until you send.
- Typing `/` lists the slash commands instead of requiring them from memory.
- `Ctrl+N` for a new chat, `Escape` to back out, `↑` in an empty composer to
  edit your last message.
- Save a conversation to your Obsidian vault as a Markdown note, through the
  same approval path as every other vault write.
