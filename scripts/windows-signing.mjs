#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { signWindowsBuild, signingReadiness, verifyWindowsBuild } from "../lib/windows-signing.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const command = process.argv[2] || "status";
const appDir = path.resolve(process.argv[3] || path.join(root, "out", "Evolv-win32-x64"));

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

try {
  if (command === "status") {
    print({
      configuration: signingReadiness(),
      buildDirectory: appDir,
      buildExists: fs.existsSync(path.join(appDir, "Evolv.exe"))
    });
  } else if (command === "sign") {
    print(signWindowsBuild(appDir));
  } else if (command === "verify" || command === "gate") {
    const verification = verifyWindowsBuild(appDir, { expectedThumbprint: process.env.WINDOWS_SIGN_CERT_SHA1 });
    print(verification);
    if (!verification.valid) process.exitCode = 1;
  } else {
    throw new Error("Use windows-signing.mjs status|sign|verify|gate [packaged-app-directory]");
  }
} catch (error) {
  console.error(`Windows signing ${command} failed: ${error.message}`);
  process.exitCode = 1;
}
