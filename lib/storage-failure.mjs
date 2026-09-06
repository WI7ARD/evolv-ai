// SQLite's own words, turned into something a person can act on.
//
// Evolv writes every message, tool result and setting to a local database, so
// the ordinary ways a computer goes wrong — a full disk, a folder that lost its
// write permission, a second copy of the app already running — all arrive here
// as an exception from better-sqlite3 with a message like "database or disk is
// full". That is accurate, and the request handler treats it as a 500, which
// means what the person actually sees is:
//
//   Unexpected server error. Reference: 4f9c1a3e-…
//
// Their disk is full and Evolv is telling them it has a bug. The reference is
// for a log they will never read. None of these are Evolv failing in a way a
// stack trace would help with, and every one of them has an obvious next step,
// so each is named and the next step said out loud.

const FAILURES = [
  {
    match: /^SQLITE_FULL/,
    status: 507,
    message: "There is no space left on the disk, so this could not be saved. Nothing already saved was lost. Free some space and try again."
  },
  {
    match: /^SQLITE_READONLY/,
    status: 500,
    message: "Evolv cannot write to its own database — the file or its folder is read-only. Check the permissions on the Evolv data folder, then restart Evolv."
  },
  {
    // Two Evolv windows on one database, or a backup tool holding it open.
    match: /^SQLITE_(BUSY|LOCKED|PROTOCOL)/,
    status: 503,
    retryAfter: 2,
    message: "Something else is using Evolv's database right now — usually a second copy of Evolv that is still running. Close the other window and try again."
  },
  {
    match: /^SQLITE_(CORRUPT|NOTADB)/,
    status: 500,
    message: "Evolv's database file is damaged and cannot be read. Evolv keeps daily backups in the backups folder beside it; restoring the most recent one is the way back."
  },
  {
    match: /^SQLITE_CANTOPEN/,
    status: 500,
    message: "Evolv could not open its database file. The data folder may have been moved, renamed, or be on a drive that is no longer connected."
  },
  {
    // Disk-level trouble under the filesystem: a failing drive, a network share
    // that dropped, an unplugged external disk.
    match: /^SQLITE_IOERR/,
    status: 500,
    message: "The disk reported an error while Evolv was reading or writing its database. If Evolv's data folder is on an external or network drive, check that it is still connected."
  }
];

// What to tell the person, or null when the ordinary handling should stand.
//
// Deliberately not a catch-all over every SQLITE_ code. A constraint violation,
// a type mismatch, a misused statement — those are Evolv asking for something
// wrong, and they are bugs. Dressing one up with "restarting Evolv usually
// fixes this" would send someone to reboot over a defect that will happen again
// every time, and would keep it out of the logs where it belongs. Only the
// codes that mean the storage underneath Evolv failed are claimed here.
export function describeStorageFailure(error) {
  const code = String(error?.code || "");
  if (!code.startsWith("SQLITE_")) return null;
  const found = FAILURES.find((failure) => failure.match.test(code));
  if (!found) return null;
  return { code, status: found.status, message: found.message, ...(found.retryAfter ? { retryAfter: found.retryAfter } : {}) };
}

export function isStorageFailure(error) {
  return describeStorageFailure(error) !== null;
}
