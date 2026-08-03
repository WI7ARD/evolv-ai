import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { createAuthService } from "../lib/auth.mjs";
import { createAccountStore } from "../lib/accounts.mjs";

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "a newer correct horse battery staple";
let child;
let dataDir;
let dbPath;
let cookie = "";
let csrfToken = "";
let recoveryCode = "";

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

async function jsonRequest(pathname, body, extraHeaders = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

async function startServer() {
  child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      OLLAMA_URL: "http://127.0.0.1:1",
      EVOLV_DATA_DIR: dataDir,
      EVOLV_DB_PATH: dbPath,
      EVOLV_SCRYPT_N: "1024"
    },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Auth test server did not start.");
}

function rawStatus(pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: PORT, path: pathname, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "evolv-auth-"));
  dbPath = path.join(dataDir, "test.db");
  await startServer();
});

test.after(async () => {
  child?.kill();
  await delay(150);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test("first run exposes only setup and protected resources stay locked", async () => {
  const statusResponse = await fetch(`${BASE}/api/auth/status`);
  const status = await statusResponse.json();
  assert.equal(status.configured, false);
  assert.ok(status.setupNonce);

  const root = await fetch(`${BASE}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/login.html");
  assert.equal((await fetch(`${BASE}/app.js`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 401);
  assert.equal((await fetch(`${BASE}/models/gesture_recognizer.task`)).status, 401);
  const loginLogo = await fetch(`${BASE}/assets/evolv-logo.png`);
  assert.equal(loginLogo.status, 200);
  assert.equal(loginLogo.headers.get("content-type"), "image/png");

  assert.equal(root.headers.get("x-frame-options"), "DENY");
  assert.match(root.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(root.headers.get("permissions-policy"), /camera=\(self\)/);
  assert.match(root.headers.get("permissions-policy"), /microphone=\(self\)/);
});

test("setup validates nonce and password then stores only hashes", async () => {
  const status = await (await fetch(`${BASE}/api/auth/status`)).json();
  const badNonce = await jsonRequest("/api/auth/setup", {
    setupNonce: "wrong",
    password: PASSWORD,
    confirmPassword: PASSWORD
  });
  assert.equal(badNonce.response.status, 403);
  await delay(300);

  const weak = await jsonRequest("/api/auth/setup", {
    setupNonce: status.setupNonce,
    password: "too short",
    confirmPassword: "too short"
  });
  assert.equal(weak.response.status, 400);

  const setup = await jsonRequest("/api/auth/setup", {
    setupNonce: status.setupNonce,
    password: PASSWORD,
    confirmPassword: PASSWORD
  });
  assert.equal(setup.response.status, 201);
  assert.match(setup.response.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(setup.response.headers.get("set-cookie"), /SameSite=Strict/i);
  assert.doesNotMatch(setup.response.headers.get("set-cookie"), /Domain=/i);
  cookie = cookieFrom(setup.response);
  csrfToken = setup.payload.csrfToken;
  recoveryCode = setup.payload.recoveryCode;
  assert.match(recoveryCode, /^[A-F0-9]{8}(?:-[A-F0-9]{8}){4}$/);

  const sqlite = new Database(path.join(dataDir, "accounts.db"), { readonly: true });
  const credential = sqlite.prepare("SELECT * FROM users WHERE username = 'owner'").get();
  sqlite.close();
  assert.ok(credential.password_hash);
  assert.notEqual(credential.password_hash, PASSWORD);
  assert.ok(credential.recovery_hash);
  assert.notEqual(credential.recovery_hash, recoveryCode);

  const duplicate = await jsonRequest("/api/auth/setup", {
    setupNonce: status.setupNonce,
    password: PASSWORD,
    confirmPassword: PASSWORD
  });
  assert.equal(duplicate.response.status, 403);
});

test("authenticated routes enforce CSRF, origin, and host boundaries", async () => {
  const health = await fetch(`${BASE}/api/health`, { headers: { cookie } });
  assert.equal(health.status, 200);

  const missingCsrf = await fetch(`${BASE}/api/conversations`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ title: "blocked" })
  });
  assert.equal(missingCsrf.status, 403);

  const hostileOrigin = await fetch(`${BASE}/api/conversations`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-evolv-csrf": csrfToken,
      origin: "https://evil.example"
    },
    body: JSON.stringify({ title: "blocked" })
  });
  assert.equal(hostileOrigin.status, 403);

  assert.equal(await rawStatus("/api/auth/status", { host: "evil.example" }), 403);

  const allowed = await fetch(`${BASE}/api/conversations`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-evolv-csrf": csrfToken,
      origin: BASE
    },
    body: JSON.stringify({ title: "<img src=x onerror=alert(1)>" })
  });
  assert.equal(allowed.status, 201);
  assert.equal((await allowed.json()).title, "<img src=x onerror=alert(1)>");
});

test("login rate limiting, logout, and password changes invalidate sessions", async () => {
  const logout = await fetch(`${BASE}/api/auth/logout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-evolv-csrf": csrfToken, origin: BASE },
    body: "{}"
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { cookie } })).status, 401);

  const invalid = await jsonRequest("/api/auth/login", { password: "not the password" });
  assert.equal(invalid.response.status, 401);
  const limited = await jsonRequest("/api/auth/login", { password: PASSWORD });
  assert.equal(limited.response.status, 429);
  await delay(300);

  const login = await jsonRequest("/api/auth/login", { password: PASSWORD });
  assert.equal(login.response.status, 200);
  cookie = cookieFrom(login.response);
  csrfToken = login.payload.csrfToken;

  const changed = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-evolv-csrf": csrfToken, origin: BASE },
    body: JSON.stringify({
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
      confirmPassword: NEXT_PASSWORD
    })
  });
  assert.equal(changed.status, 200);
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { cookie } })).status, 401);
});

test("recovery is single-use, rotates its code, and creates a fresh session", async () => {
  const recovered = await jsonRequest("/api/auth/recover", {
    recoveryCode,
    newPassword: PASSWORD,
    confirmPassword: PASSWORD
  });
  assert.equal(recovered.response.status, 200);
  assert.notEqual(recovered.payload.recoveryCode, recoveryCode);
  cookie = cookieFrom(recovered.response);
  csrfToken = recovered.payload.csrfToken;
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { cookie } })).status, 200);

  const reused = await jsonRequest("/api/auth/recover", {
    recoveryCode,
    newPassword: NEXT_PASSWORD,
    confirmPassword: NEXT_PASSWORD
  });
  assert.equal(reused.response.status, 401);
});

test("server restart invalidates every memory-only session", async () => {
  child.kill();
  await delay(250);
  await startServer();
  const status = await (await fetch(`${BASE}/api/auth/status`, { headers: { cookie } })).json();
  assert.equal(status.configured, true);
  assert.equal(status.authenticated, false);
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { cookie } })).status, 401);
});

test("session service enforces idle and absolute expiration with a deterministic clock", async () => {
  const localDir = await mkdtemp(path.join(tmpdir(), "evolv-auth-clock-"));
  const accounts = createAccountStore({ dataDir: localDir });
  let timestamp = 1_000;
  const service = createAuthService({
    accounts,
    now: () => timestamp,
    idleMs: 1_000,
    absoluteMs: 5_000,
    scryptN: 1024
  });
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const setupStatus = service.status(request);
  const setup = await service.setup(request, {
    setupNonce: setupStatus.setupNonce,
    password: PASSWORD,
    confirmPassword: PASSWORD
  });
  request.headers.cookie = cookieFrom({ headers: new Headers({ "set-cookie": setup.setCookie }) });
  assert.equal(service.status(request).authenticated, true);
  timestamp += 1_001;
  assert.equal(service.status(request).authenticated, false);

  const login = await service.login(request, { password: PASSWORD });
  request.headers.cookie = cookieFrom({ headers: new Headers({ "set-cookie": login.setCookie }) });
  for (let index = 0; index < 4; index += 1) {
    timestamp += 900;
    assert.equal(service.status(request).authenticated, true);
  }
  timestamp += 1_500;
  assert.equal(service.status(request).authenticated, false);
  accounts.close();
  await rm(localDir, { recursive: true, force: true });
});
