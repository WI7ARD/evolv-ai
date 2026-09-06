# Evolv Personal 0.7.1

Two fixes. The first will matter to anyone whose account stopped opening.

## Existing accounts open again

Evolv keeps a ledger of the schema changes it has applied to your database, with
a checksum of each one, and refuses to open a database whose recorded schema no
longer matches the code. That check is worth having: it is how you find out that
a build and a database disagree *before* something writes to the wrong shape.

It fired for real. The circuits table — added when the circuit sandbox shipped —
was appended to the end of an existing migration rather than being added as its
own. That rewrote schema every existing database had already run, so every
account created before that point was refused, while a newly created account
worked perfectly. The failure looked like "my data is gone". It never was: the
database was untouched and merely refused at the door.

The circuits table now has its own migration, which restores the altered one to
exactly the text it shipped with. Accounts created before the mistake open
again. Accounts created *during* it — which recorded the altered checksum and
would now have been refused for the mirror-image reason — are recognised and
corrected on the next start. Both keep every conversation.

Two things stop it recurring. A test now pins the checksum of every migration
that has ever shipped, so editing one fails in seconds on the build machine
rather than silently on someone's disk months later. And if the check ever does
fire again, it now says what happened and that the data is intact, instead of
an error code and a reference number.

## Updating no longer costs disk you never get back

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
