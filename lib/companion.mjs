// Pairing a phone with this computer.
//
// This module is the lock, and it exists before the door. Evolv's server binds
// to 127.0.0.1 and rejects any Host or Origin that is not loopback — four
// deliberate locks that make it safe to run an AI workspace, an Obsidian vault
// and a set of API keys on a laptop. A phone companion has to open one of
// those, and opening a port before there is a way to authenticate what comes
// through it would expose all of that to anyone on the same cafe wifi.
//
// So: a device proves it was physically shown a short-lived code on the
// desktop, and trades that code once for a long-lived token. Nothing is
// exposed to the network by this file — it decides who is allowed, not what is
// listening.
import crypto from "node:crypto";

// Long enough that guessing is hopeless inside its lifetime, short enough to
// read off a screen and thumb into a phone. Digits and letters that cannot be
// confused for each other: no O/0, no I/1/L.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function companionError(message, status = 400, code = "COMPANION_ERROR") {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("base64");
}

// Compare without leaking length or position through timing. Two different
// lengths are simply not equal; timingSafeEqual would throw on them.
function sameSecret(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function formatPairingCode(code) {
  return String(code).replace(/(.{4})(?=.)/g, "$1-");
}

export function normalizePairingCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function createCompanionService({ database, clock = () => Date.now() } = {}) {
  // Deliberately in memory. A pairing code lives for five minutes; writing it
  // to disk only adds a place it can leak from, and losing pending codes on
  // restart is the correct behaviour anyway.
  let pending = null;

  function activeCode() {
    if (!pending) return null;
    if (clock() > pending.expiresAt) {
      pending = null;
      return null;
    }
    return pending;
  }

  return {
    // Shown on the desktop. Starting a new pairing invalidates any code still
    // outstanding, so exactly one code is ever live.
    startPairing() {
      const bytes = crypto.randomBytes(CODE_LENGTH);
      const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
      pending = { code, expiresAt: clock() + CODE_TTL_MS, attempts: 0 };
      return { code, display: formatPairingCode(code), expiresAt: pending.expiresAt };
    },

    cancelPairing() {
      pending = null;
    },

    pendingPairing() {
      const live = activeCode();
      return live ? { display: formatPairingCode(live.code), expiresAt: live.expiresAt } : null;
    },

    // One code, one device, one use. A wrong guess counts against the code
    // rather than against the phone, so an attacker cannot get more tries by
    // changing address.
    redeemPairing(input, { name = "Phone" } = {}) {
      const live = activeCode();
      if (!live) throw companionError("That pairing code has expired. Start pairing again on your computer.", 410, "PAIRING_EXPIRED");

      if (live.attempts >= MAX_ATTEMPTS) {
        pending = null;
        throw companionError("Too many incorrect codes. Start pairing again on your computer.", 429, "PAIRING_LOCKED");
      }

      const supplied = normalizePairingCode(input);
      if (!sameSecret(supplied, live.code)) {
        live.attempts += 1;
        const left = MAX_ATTEMPTS - live.attempts;
        throw companionError(
          left > 0 ? `That code does not match. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many incorrect codes. Start pairing again on your computer.",
          401,
          "PAIRING_REJECTED"
        );
      }

      pending = null;
      const token = crypto.randomBytes(32).toString("base64url");
      const device = database.addCompanionDevice({
        id: crypto.randomUUID(),
        name: String(name || "Phone").trim().slice(0, 80) || "Phone",
        tokenHash: hashToken(token)
      });
      database.audit?.("companion.paired", `Paired ${device.name}`, {
        entityType: "companion", entityId: device.id
      });
      // The only time the token is ever readable. It is hashed at rest, so it
      // cannot be shown again — which is the point.
      return { token, device };
    },

    // Returns the device for a presented token, or null. Never throws on a bad
    // token: the caller decides what an unauthenticated request means.
    verifyToken(token) {
      if (!token) return null;
      const device = database.findCompanionDeviceByTokenHash(hashToken(token));
      if (!device) return null;
      database.touchCompanionDevice(device.id);
      return device;
    },

    listDevices() {
      return database.listCompanionDevices();
    },

    revokeDevice(id) {
      const revoked = database.revokeCompanionDevice(id);
      if (revoked) database.audit?.("companion.revoked", "Revoked a paired device", {
        entityType: "companion", entityId: String(id)
      });
      return revoked;
    }
  };
}
