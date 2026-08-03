import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THUMBPRINT = /^[A-F0-9]{40}$/;

function findRecursive(root, predicate) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const pending = [path.resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && predicate(candidate)) files.push(candidate);
    }
  }
  return files;
}

export function findSignTool(env = process.env) {
  const explicit = String(env.SIGNTOOL_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const roots = [
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Windows Kits", "10", "bin"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Windows Kits", "10", "bin")
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => findRecursive(root, (candidate) =>
    path.basename(candidate).toLowerCase() === "signtool.exe" && candidate.toLowerCase().includes(`${path.sep}x64${path.sep}`)));
  return candidates.sort().reverse()[0] || "";
}

export function signingReadiness({ env = process.env, platform = process.platform } = {}) {
  const thumbprint = String(env.WINDOWS_SIGN_CERT_SHA1 || "").replace(/\s+/g, "").toUpperCase();
  const timestampUrl = String(env.WINDOWS_TIMESTAMP_URL || "").trim();
  const signTool = findSignTool(env);
  const errors = [];
  if (platform !== "win32") errors.push("Windows signing must run on Windows.");
  if (!THUMBPRINT.test(thumbprint)) errors.push("WINDOWS_SIGN_CERT_SHA1 must be a 40-character SHA-1 certificate thumbprint.");
  try {
    const parsed = new URL(timestampUrl);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error();
  } catch {
    errors.push("WINDOWS_TIMESTAMP_URL must be an HTTP(S) RFC 3161 timestamp service.");
  }
  if (!signTool) errors.push("signtool.exe was not found. Install the Windows SDK or set SIGNTOOL_PATH.");
  return { ready: errors.length === 0, thumbprint, timestampUrl, signTool, errors };
}

export function signingTargets(appDir) {
  const root = path.resolve(appDir);
  const executable = path.join(root, "Evolv.exe");
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`);
  const nativeModules = findRecursive(path.join(root, "resources", "app.asar.unpacked"), (candidate) =>
    path.extname(candidate).toLowerCase() === ".node");
  return [executable, ...nativeModules].sort();
}

function authenticode(target) {
  const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:EVOLV_SIGNATURE_TARGET;"
    + "[pscustomobject]@{Status=[string]$s.Status;Thumbprint=[string]$s.SignerCertificate.Thumbprint;"
    + "Subject=[string]$s.SignerCertificate.Subject;StatusMessage=[string]$s.StatusMessage}|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, EVOLV_SIGNATURE_TARGET: target }
  });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || "Authenticode verification failed.");
  return JSON.parse(result.stdout.trim());
}

export function verifyWindowsBuild(appDir, { expectedThumbprint = "" } = {}) {
  if (process.platform !== "win32") throw new Error("Authenticode verification must run on Windows.");
  const expected = String(expectedThumbprint || "").replace(/\s+/g, "").toUpperCase();
  const files = signingTargets(appDir).map((target) => ({ target, ...authenticode(target) }));
  const failures = files.filter((file) => file.Status !== "Valid"
    || (expected && String(file.Thumbprint || "").toUpperCase() !== expected));
  return { valid: failures.length === 0, expectedThumbprint: expected, files, failures };
}

export function signWindowsBuild(appDir, { env = process.env } = {}) {
  const readiness = signingReadiness({ env });
  if (!readiness.ready) throw new Error(readiness.errors.join(" "));
  const targets = signingTargets(appDir);
  for (const target of targets) {
    const result = spawnSync(readiness.signTool, [
      "sign", "/sha1", readiness.thumbprint, "/fd", "SHA256",
      "/tr", readiness.timestampUrl, "/td", "SHA256", "/v", target
    ], { stdio: "inherit", shell: false });
    if (result.error || result.status !== 0) throw result.error || new Error(`signtool failed for ${target}`);
  }
  const verification = verifyWindowsBuild(appDir, { expectedThumbprint: readiness.thumbprint });
  if (!verification.valid) throw new Error(`Authenticode verification failed for ${verification.failures.length} file(s).`);
  return verification;
}
