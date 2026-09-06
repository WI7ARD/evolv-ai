// Screenshots for the devlog, taken from a real running Evolv rather than
// mocked, so they cannot drift from what the app actually looks like.
//
//   npm i -D playwright && npx playwright install chromium
//   node scripts/devlog-shots.mjs
//
// Playwright is deliberately NOT a dependency of this project: it pulls a
// browser down with it, and nobody installing Evolv needs one to run Evolv.
// It is a documentation tool, so it is asked for only when documentation is
// being written.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const { chromium } = await import("playwright").catch(() => {
  console.error("This script needs Playwright, which Evolv does not depend on.\n"
    + "  npm i -D playwright && npx playwright install chromium");
  process.exit(1);
});

const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets");
const PASSWORD = "correct horse battery staple";

await mkdir(OUT, { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), "evolv-devlog-"));
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, PORT: String(PORT), EVOLV_DATA_DIR: dataDir, EVOLV_DB_PATH: path.join(dataDir, "d.db"), EVOLV_SCRYPT_N: "1024" },
  stdio: "ignore"
});
process.on("exit", () => child.kill());
for (let i = 0; i < 80; i += 1) {
  try { if ((await fetch(`${BASE}/api/auth/status`)).ok) break; } catch {}
  await delay(200);
}

const browser = await chromium.launch({ ...(process.env.EVOLV_CHROMIUM ? { executablePath: process.env.EVOLV_CHROMIUM } : {}) });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE);
await page.waitForTimeout(3000);
await page.fill("#setup-username", "evolv");
await page.fill("#setup-password", PASSWORD);
await page.fill("#setup-confirm", PASSWORD);
await page.click("button:has-text('Create account')");
await page.waitForTimeout(2500);
await page.check("input[type=checkbox]").catch(() => {});
await page.click("button:has-text('Continue to Evolv')").catch(() => {});
await page.waitForSelector("#prompt", { timeout: 20000 });
await page.waitForTimeout(1200);

// The demo panel itself.
await page.fill("#prompt", "/demo");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
// Wait out any toast before capturing. This container has no Ollama, so the
// model list fails and pops one; on a machine with Ollama running it does not
// appear at all, and a docs screenshot should show the normal case.
await page.waitForFunction(() => !document.querySelector("#toast-region")?.childElementCount, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
await writeFile(path.join(OUT, "demo-panel.png"), await page.locator("#demo-view").screenshot());
console.log("wrote demo-panel.png");

// Run the friction demo and capture the world once it has settled.
await page.selectOption("#demo-script", "friction");
await page.click("#demo-start");
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(700);
  const running = await page.evaluate(() => !document.querySelector("#demo-hud")?.classList.contains("hidden"));
  if (!running && i > 3) break;
}
await page.waitForFunction(() => !document.querySelector("#toast-region")?.childElementCount, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
await writeFile(path.join(OUT, "demo-friction.png"), await page.locator("#physics-canvas").screenshot());
console.log("wrote demo-friction.png", await page.textContent("#demo-status"));

// The lab display. Back to chat first — the demo leaves us on the physics
// view, where the composer is hidden.
await page.click("#physics-back-to-chat").catch(async () => { await page.click("#demo-back-to-chat").catch(() => {}); });
await page.waitForTimeout(800);
await page.fill("#prompt", "/lab");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
await page.waitForFunction(() => !document.querySelector("#toast-region")?.childElementCount, null, { timeout: 15000 }).catch(() => {});
await writeFile(path.join(OUT, "lab-display.png"), await page.locator("#lab-view").screenshot());
console.log("wrote lab-display.png");

await browser.close();
child.kill();
