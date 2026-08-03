import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);
const COOKIE_NAME = "evolv_session";
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;

function httpError(status, message, code = "AUTH_ERROR") {
  return Object.assign(new Error(message), { status, code });
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeRecoveryCode(value) {
  return String(value || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
}

function recoveryHash(value) {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(value), "utf8").digest("base64");
}

function generateRecoveryCode() {
  return crypto.randomBytes(20).toString("hex").toUpperCase().match(/.{1,8}/g).join("-");
}

function parseCookies(header = "") {
  const output = {};
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      output[key] = decodeURIComponent(value);
    } catch {}
  }
  return output;
}

function validatePassword(password) {
  if (typeof password !== "string") throw httpError(400, "Password is required.", "INVALID_PASSWORD");
  const length = [...password].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw httpError(400, `Password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`, "INVALID_PASSWORD");
  }
  return password;
}

export function createAuthService({
  accounts,
  now = () => Date.now(),
  idleMs = Number(process.env.EVOLV_SESSION_IDLE_MS) || DEFAULT_IDLE_MS,
  absoluteMs = Number(process.env.EVOLV_SESSION_ABSOLUTE_MS) || DEFAULT_ABSOLUTE_MS,
  scryptN = Number(process.env.EVOLV_SCRYPT_N) || 131072
}) {
  const scryptOptions = {
    N: Math.max(1024, scryptN),
    r: 8,
    p: 1,
    maxmem: Math.max(256 * 1024 * 1024, 128 * Math.max(1024, scryptN) * 8 * 2)
  };
  const keyLength = 64;
  const sessions = new Map();
  const attempts = new Map();
  let registrationNonce = crypto.randomBytes(32).toString("base64url");

  async function derive(password, salt, options = scryptOptions, length = keyLength) {
    return Buffer.from(await scryptAsync(password, Buffer.from(salt, "base64"), length, options));
  }

  async function makePasswordRecord(password, recoveryCode) {
    validatePassword(password);
    const salt = crypto.randomBytes(24).toString("base64");
    const hash = await derive(password, salt);
    return {
      passwordHash: hash.toString("base64"),
      passwordSalt: salt,
      scryptN: scryptOptions.N,
      scryptR: scryptOptions.r,
      scryptP: scryptOptions.p,
      keyLength,
      recoveryHash: recoveryHash(recoveryCode)
    };
  }

  async function verifyPassword(password, record) {
    if (typeof password !== "string" || [...password].length > PASSWORD_MAX || !record) return false;
    try {
      const derived = await derive(password, record.passwordSalt, {
        N: record.scryptN,
        r: record.scryptR,
        p: record.scryptP,
        maxmem: Math.max(256 * 1024 * 1024, 128 * record.scryptN * record.scryptR * 2)
      }, record.keyLength);
      return safeEqual(derived, Buffer.from(record.passwordHash, "base64"));
    } catch {
      return false;
    }
  }

  function sessionKey(token) {
    return crypto.createHash("sha256").update(token).digest("base64url");
  }

  function purgeSessions() {
    const timestamp = now();
    for (const [key, session] of sessions) {
      if (timestamp - session.lastSeenAt > idleMs || timestamp - session.createdAt > absoluteMs) sessions.delete(key);
    }
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function invalidateUserSessions(userId) {
    for (const [key, session] of sessions) {
      if (session.userId === userId) sessions.delete(key);
    }
  }

  function newSession(user) {
    purgeSessions();
    const token = crypto.randomBytes(32).toString("base64url");
    const timestamp = now();
    const session = {
      userId: user.id,
      username: user.username,
      csrfToken: crypto.randomBytes(32).toString("base64url"),
      createdAt: timestamp,
      lastSeenAt: timestamp
    };
    sessions.set(sessionKey(token), session);
    purgeSessions();
    return { token, session };
  }

  function readSession(req, { touch = true } = {}) {
    purgeSessions();
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const key = sessionKey(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (touch) session.lastSeenAt = now();
    return { key, token, session };
  }

  function requireSession(req) {
    const current = readSession(req);
    if (!current) throw httpError(401, "Authentication required.", "AUTH_REQUIRED");
    return current;
  }

  function requireCsrf(req, session) {
    const token = req.headers["x-evolv-csrf"];
    if (typeof token !== "string" || !safeEqual(token, session.csrfToken)) {
      throw httpError(403, "Invalid security token. Reload Evolv and try again.", "CSRF_REJECTED");
    }
  }

  function limiterKey(action, req) {
    return `${action}:${req.socket.remoteAddress || "local"}`;
  }

  function checkRateLimit(action, req) {
    const key = limiterKey(action, req);
    const state = attempts.get(key);
    if (!state) return;
    if (state.resetAt <= now()) {
      attempts.delete(key);
      return;
    }
    if (state.nextAllowedAt > now()) {
      const retryAfter = Math.max(1, Math.ceil((state.nextAllowedAt - now()) / 1000));
      const error = httpError(429, `Too many attempts. Try again in ${retryAfter} seconds.`, "RATE_LIMITED");
      error.retryAfter = retryAfter;
      throw error;
    }
  }

  function recordFailure(action, req) {
    const key = limiterKey(action, req);
    const previous = attempts.get(key);
    const failures = (previous?.failures || 0) + 1;
    const delay = Math.min(60_000, 250 * (2 ** Math.min(failures - 1, 8)));
    attempts.set(key, {
      failures,
      nextAllowedAt: now() + delay,
      resetAt: now() + 15 * 60 * 1000
    });
  }

  function clearFailures(action, req) {
    attempts.delete(limiterKey(action, req));
  }

  function cookie(token) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(absoluteMs / 1000)}; Priority=High`;
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  function publicStatus(req) {
    const configured = accounts.countUsers() > 0;
    const current = configured ? readSession(req) : null;
    return {
      configured,
      authenticated: Boolean(current),
      registrationEnabled: accounts.countUsers() < 25,
      registrationNonce,
      setupNonce: registrationNonce,
      user: current ? { id: current.session.userId, username: current.session.username } : undefined,
      csrfToken: current?.session.csrfToken,
      idleTimeoutMs: idleMs,
      absoluteTimeoutMs: absoluteMs
    };
  }

  async function register(req, body) {
    checkRateLimit("register", req);
    const suppliedNonce = String(body?.registrationNonce || body?.setupNonce || "");
    if (!safeEqual(suppliedNonce, registrationNonce)) {
      recordFailure("register", req);
      throw httpError(403, "The registration session is invalid. Reload the page.", "REGISTRATION_REJECTED");
    }
    const password = validatePassword(body.password);
    if (password !== body.confirmPassword) throw httpError(400, "Passwords do not match.", "PASSWORD_MISMATCH");
    const recoveryCode = generateRecoveryCode();
    const username = body?.username || "owner";
    const user = accounts.createUser(username, await makePasswordRecord(password, recoveryCode));
    registrationNonce = crypto.randomBytes(32).toString("base64url");
    clearFailures("register", req);
    const created = newSession(user);
    accounts.audit("auth.register", "Created a local Evolv profile", user.id);
    return { recoveryCode, csrfToken: created.session.csrfToken, setCookie: cookie(created.token), user };
  }

  async function login(req, body) {
    checkRateLimit("login", req);
    if (!accounts.countUsers()) throw httpError(409, "Create an Evolv account first.", "SETUP_REQUIRED");
    const record = body?.username ? accounts.findUser(body.username) : accounts.getOnlyUser();
    if (!record || !await verifyPassword(body?.password, record)) {
      recordFailure("login", req);
      accounts.audit("auth.login_failed", "Rejected an invalid login attempt", record?.id || null);
      throw httpError(401, "Incorrect username or password.", "INVALID_CREDENTIALS");
    }
    clearFailures("login", req);
    const created = newSession(record);
    accounts.audit("auth.login", "Created an authenticated local session", record.id);
    return { csrfToken: created.session.csrfToken, setCookie: cookie(created.token), user: record };
  }

  function logout(req) {
    const current = readSession(req, { touch: false });
    if (current) sessions.delete(current.key);
    accounts.audit("auth.logout", "Closed a local session", current?.session.userId || null);
    return { setCookie: clearCookie() };
  }

  async function changePassword(req, body) {
    const current = requireSession(req);
    requireCsrf(req, current.session);
    const record = accounts.getUser(current.session.userId);
    if (!await verifyPassword(body?.currentPassword, record)) {
      throw httpError(401, "Current password is incorrect.", "INVALID_CREDENTIALS");
    }
    const password = validatePassword(body?.newPassword);
    if (password !== body?.confirmPassword) throw httpError(400, "Passwords do not match.", "PASSWORD_MISMATCH");
    const next = await makePasswordRecord(password, crypto.randomBytes(20).toString("hex"));
    next.recoveryHash = record.recoveryHash;
    accounts.updateCredential(record.id, next);
    invalidateUserSessions(record.id);
    accounts.audit("auth.password_changed", "Changed the Evolv password and invalidated all sessions", record.id);
    return { setCookie: clearCookie() };
  }

  async function recover(req, body) {
    checkRateLimit("recover", req);
    const record = body?.username ? accounts.findUser(body.username) : accounts.getOnlyUser();
    if (!record) throw httpError(401, "Username or recovery code is incorrect.", "INVALID_RECOVERY_CODE");
    const suppliedHash = recoveryHash(body?.recoveryCode);
    if (!normalizeRecoveryCode(body?.recoveryCode) || !safeEqual(suppliedHash, record.recoveryHash)) {
      recordFailure("recover", req);
      accounts.audit("auth.recovery_failed", "Rejected an invalid recovery attempt", record.id);
      throw httpError(401, "Username or recovery code is incorrect.", "INVALID_RECOVERY_CODE");
    }
    const password = validatePassword(body?.newPassword);
    if (password !== body?.confirmPassword) throw httpError(400, "Passwords do not match.", "PASSWORD_MISMATCH");
    const nextRecoveryCode = generateRecoveryCode();
    accounts.updateCredential(record.id, await makePasswordRecord(password, nextRecoveryCode));
    invalidateUserSessions(record.id);
    clearFailures("recover", req);
    const created = newSession(record);
    accounts.audit("auth.recovered", "Recovered access, rotated the recovery code, and invalidated all sessions", record.id);
    return {
      recoveryCode: nextRecoveryCode,
      csrfToken: created.session.csrfToken,
      setCookie: cookie(created.token),
      user: record
    };
  }

  return {
    cookieName: COOKIE_NAME,
    status: publicStatus,
    setup: register,
    register,
    login,
    logout,
    changePassword,
    recover,
    requireSession,
    requireCsrf,
    clearCookie,
    sessionCount: () => sessions.size
  };
}
