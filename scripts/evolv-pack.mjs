#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { readPackSourceDirectory, watchPackSource } from "../lib/pack-dev.mjs";
import { validatePackPackage } from "../lib/marketplace.mjs";
import { publisherKeyId, signPackPackage } from "../lib/marketplace-signing.mjs";

function usage() {
  console.log(`Evolv Pack CLI

Commands:
  evolv-pack validate <pack.evolvpack|source-folder>
  evolv-pack build <source-folder> --output <pack.evolvpack>
  evolv-pack watch <source-folder> --output <pack.evolvpack>
  evolv-pack keygen --output <publisher-name>
  evolv-pack sign <pack.evolvpack> --private-key <key.pem> --publisher-id <id> --publisher-name <name> --output <signed.evolvpack>

Validation uses the same bounded parser as Evolv. Watch rebuilds only after a
successful validation and keeps the previous output when a change is invalid.`);
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function platform() {
  return option("platform", process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform);
}

function loadPackage(candidate) {
  const target = path.resolve(candidate);
  return fs.statSync(target).isDirectory()
    ? readPackSourceDirectory(target)
    : JSON.parse(fs.readFileSync(target, "utf8"));
}

function validated(candidate) {
  return validatePackPackage(loadPackage(candidate), {
    platform: platform() === "windows" ? "win32" : platform() === "macos" ? "darwin" : platform()
  });
}

function writePackage(output, packPackage) {
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(packPackage, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function build(source, output) {
  const packPackage = validated(source);
  const serializable = {
    packageVersion: 1,
    manifest: packPackage.manifest,
    files: packPackage.files,
    ...(packPackage.publisher ? { publisher: packPackage.publisher, signature: packPackage.signature } : {})
  };
  const target = writePackage(output, serializable);
  console.log(`Valid ${packPackage.manifest.id}@${packPackage.manifest.version} · ${Object.keys(packPackage.files).length} files · ${target}`);
  return packPackage;
}

async function main() {
  const command = process.argv[2];
  const target = process.argv[3];
  if (!command || ["help", "--help", "-h"].includes(command)) return usage();
  if (command === "validate") {
    if (!target) throw new Error("Choose a package file or source folder.");
    const checked = validated(target);
    console.log(JSON.stringify({
      valid: true,
      id: checked.manifest.id,
      version: checked.manifest.version,
      files: Object.keys(checked.files).length,
      signature: checked.verification.state,
      permissions: checked.manifest.permissions.map((item) => item.id)
    }, null, 2));
    return;
  }
  if (command === "build") {
    if (!target || !option("output")) throw new Error("Build needs a source folder and --output.");
    build(target, option("output"));
    return;
  }
  if (command === "watch") {
    if (!target || !option("output")) throw new Error("Watch needs a source folder and --output.");
    let timer;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { build(target, option("output")); } catch (error) { console.error(`Not rebuilt: ${error.message}`); }
      }, 180);
    };
    build(target, option("output"));
    const close = watchPackSource(target, rebuild);
    const stop = () => { clearTimeout(timer); close(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log("Watching for validated rebuilds. Press Ctrl+C to stop.");
    return await new Promise(() => {});
  }
  if (command === "keygen") {
    const output = option("output");
    if (!output) throw new Error("Keygen needs --output <publisher-name>.");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const base = path.resolve(output);
    fs.writeFileSync(`${base}.public.pem`, publicPem, { encoding: "utf8", mode: 0o644, flag: "wx" });
    fs.writeFileSync(`${base}.private.pem`, privatePem, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`Created ${base}.public.pem and ${base}.private.pem`);
    console.log(`Publisher key ID: ${publisherKeyId(publicPem)}`);
    console.log("Keep the private key outside pack folders and never publish it.");
    return;
  }
  if (command === "sign") {
    const privateKeyFile = option("private-key");
    const publisherId = option("publisher-id");
    const publisherName = option("publisher-name");
    const output = option("output");
    if (!target || !privateKeyFile || !publisherId || !publisherName || !output) {
      throw new Error("Sign needs a package, private key, publisher ID, publisher name, and output.");
    }
    const privateKey = fs.readFileSync(path.resolve(privateKeyFile), "utf8");
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey(privateKey)).export({ type: "spki", format: "pem" });
    const checked = validated(target);
    const signed = signPackPackage(checked, {
      publisher: { id: publisherId, name: publisherName, publicKey },
      privateKey
    });
    writePackage(output, signed);
    validated(output);
    console.log(`Signed ${checked.manifest.id}@${checked.manifest.version} with ${publisherKeyId(publicKey)}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Evolv Pack CLI: ${error.message}`);
  process.exitCode = 1;
});
