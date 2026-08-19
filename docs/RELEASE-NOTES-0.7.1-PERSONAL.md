# Evolv Personal 0.7.1

One fix, and it is about disk rather than about anything you can see in the app.

## Updating no longer costs disk you never get back

Evolv can update itself: it downloads the published package from GitHub, checks
it against the release's SHA-256 and its own per-file integrity manifest,
unpacks it, and swaps it into place. That part worked.

What it did not do was clean up afterwards. Every update wrote a full package
into Evolv's application-data folder, and nothing ever deleted one — so a copy
of every version you had ever installed was still on your disk, at roughly two
hundred megabytes each. On Windows the swap also renames the old install aside
as a safety net, and that copy was left behind too.

None of it was visible. The folder is under `AppData`, which nobody browses to
by accident, so several gigabytes of finished downloads read from the outside as
"this app is enormous" rather than as anything to look at.

Three changes:

- **Starting up clears what the last update left behind.** Reaching the point
  where the app runs is proof the installed version works, which is exactly when
  the package it came from and the copy of the old install stop being insurance.
  Evolv already reasoned this way about the previous AppImage on Linux; it now
  does the same on Windows, and for the packages on both.

- **The package is deleted as soon as the update is unpacked and verified**,
  rather than kept until the install and then forever. That is most of the space
  back before the update has even been applied.

- **An update that will not fit is refused before it starts.** Running out of
  room halfway leaves the disk full *and* the update unfinished. Evolv now
  checks first and says what it needs against what is free — including that the
  package unpacks to about two and a half times its download size, which is the
  part nobody can be expected to guess.

Settings now shows how much the updater is holding and offers to clear it, for
when the disk is already full and you cannot wait for the next update to tidy up.

**This release cleans up retroactively.** Installing it will remove every
package left by every update before it, the first time it starts.

If your disk is too full to install this at all, the folder is safe to delete by
hand — everything in it is a finished download, and the installed app is
somewhere else entirely:

    C:\Users\<you>\AppData\Roaming\Evolv\updates
