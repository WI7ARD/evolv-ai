import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { DesktopUpdateService } from "../electron/update-service.mjs";

const zipPath = path.resolve(process.argv[2] || "");
if (!zipPath || !await fs.stat(zipPath).then((item) => item.isFile()).catch(() => false)) {
  throw new Error("Pass the packaged Evolv ZIP path.");
}
const match = path.basename(zipPath).match(/^Evolv-win32-x64-(\d+\.\d+\.\d+)\.zip$/);
if (!match) throw new Error("The release ZIP name is invalid.");
const version = match[1];
const checksumPath = `${zipPath}.sha256`;
const checksum = await fs.readFile(checksumPath, "utf8");
const zipStat = await fs.stat(zipPath);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-packaged-update-"));
const executablePath = path.join(root, "installed", "Evolv-win32-x64", "Evolv.exe");
await fs.mkdir(path.dirname(executablePath), { recursive: true });
await fs.writeFile(executablePath, "previous release");

const release = {
  tag_name: `v${version}`,
  name: `Evolv ${version}`,
  assets: [
    { name: path.basename(zipPath), browser_download_url: `https://github.com/WI7ARD/evolv-ai/releases/download/v${version}/${path.basename(zipPath)}` },
    { name: `${path.basename(zipPath)}.sha256`, browser_download_url: `https://github.com/WI7ARD/evolv-ai/releases/download/v${version}/${path.basename(zipPath)}.sha256` }
  ]
};

const fetchImpl = async (url) => {
  const value = String(url);
  if (value.includes("api.github.com")) return new Response(JSON.stringify(release), { status: 200 });
  if (value.endsWith(".sha256")) return new Response(checksum, { status: 200 });
  if (value.endsWith(".zip")) {
    return new Response(Readable.toWeb(createReadStream(zipPath)), {
      status: 200,
      headers: { "content-length": String(zipStat.size) }
    });
  }
  throw new Error(`Unexpected update request: ${value}`);
};

try {
  const [major, minor, patch] = version.split(".").map(Number);
  const service = new DesktopUpdateService({
    currentVersion: `${major}.${minor}.${Math.max(0, patch - 1)}`,
    userDataPath: path.join(root, "user-data"),
    executablePath,
    fetchImpl,
    platform: "win32"
  });
  const checked = await service.check();
  if (!checked.release?.available) throw new Error("The packaged update was not detected.");
  const staged = await service.download();
  if (!staged.readyToInstall || staged.phase !== "ready") throw new Error("The packaged update was not staged and verified.");
  console.log(JSON.stringify({ version, zipBytes: zipStat.size, checked: checked.phase, staged: staged.phase, readyToInstall: staged.readyToInstall }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
