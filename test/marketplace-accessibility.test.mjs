import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function rgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
}

function luminance(hex) {
  const channels = rgb(hex).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("Marketplace dialogs expose screen-reader names and restore keyboard focus", () => {
  for (const [dialog, title] of [
    ["marketplace-permission-dialog", "marketplace-permission-title"],
    ["marketplace-config-dialog", "marketplace-config-title"],
    ["marketplace-starter-dialog", "marketplace-starter-title"]
  ]) {
    assert.match(html, new RegExp(`<dialog[^>]*id="${dialog}"[^>]*aria-labelledby="${title}"`));
    assert.match(html, new RegExp(`id="${title}"`));
  }
  assert.match(script, /marketplaceDialogReturnFocus = document\.activeElement/);
  assert.match(script, /target\?\.isConnected\) target\.focus\(\)/);
});

test("Marketplace pack installation remains usable in a short desktop window", () => {
  assert.match(html, /id="marketplace-permission-error"[^>]*role="alert"/);
  assert.match(html, /id="marketplace-permission-select-optional"/);
  assert.match(html, /id="marketplace-permission-clear-optional"/);
  assert.match(styles, /#marketplace-permission-dialog[\s\S]*max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(styles, /#marketplace-permission-list[\s\S]*overflow-y:\s*auto/);
  assert.match(script, /if \(!dialog\.open\) dialog\.show\(\)/);
  assert.match(script, /marketplace-permission-error/);
  assert.match(script, /name === "permissions" \? "permission" : name/);
  assert.match(script, /function marketplaceDialogByName/);
  assert.match(script, /dialog\.removeAttribute\("open"\)/);
  assert.match(script, /dialog\?\.addEventListener\("cancel"/);
  assert.match(script, /if \(event\.target !== dialog\) return/);
  assert.match(script, /marketplaceInstallInFlight/);
  assert.match(script, /verified\.installedRecord/);
  assert.match(script, /marketplace-permission-confirm[^\n]*addEventListener\("click"/);
  assert.match(html, /id="marketplace-config-confirm"/);
  assert.match(script, /marketplace-config-confirm[^\n]*addEventListener\("click"/);
  assert.match(script, /if \(app\.marketplaceConfigSaveInFlight\) return/);
  assert.match(script, /querySelector\("\.marketplace-install, \.marketplace-update"\)\?\.addEventListener\("click"/);
  assert.match(script, /event\.stopPropagation\(\)/);
});

test("Marketplace dialogs avoid Chromium's keyboard-inert modal top layer", () => {
  assert.match(html, /id="marketplace-dialog-backdrop"/);
  assert.match(script, /if \(!dialog\.open\) dialog\.show\(\)/);
  assert.doesNotMatch(script, /dialog\.showModal\(\)/);
  assert.match(script, /function resetMarketplaceDialogs\(\)/);
  assert.match(script, /resetMarketplaceDialogs\(\);\s*bindEvents\(\)/);
  assert.match(script, /requestAnimationFrame\(\(\) => \{\s*if \(!dialog\.open\) return;/);
  assert.doesNotMatch(script, /requestAnimationFrame\(\(\) => \{\s*if \(!dialog\.open\) \{\s*try \{ dialog\.show\(\)/);
  assert.match(styles, /\.marketplace-dialog-backdrop[\s\S]*position:\s*fixed/);
});

test("pack configuration keeps Save and Cancel visible in short windows", () => {
  assert.match(styles, /#marketplace-config-dialog\.marketplace-dialog-visible\s*\{[\s\S]*height:\s*min\(660px, calc\(100dvh - 24px\)\)/);
  assert.match(styles, /#marketplace-config-form\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /#marketplace-config-fields\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /#marketplace-config-form > \.proposal-actions[\s\S]*border-top:/);
});

test("the complete desktop sidebar scrolls and conversation history is not height-capped", () => {
  assert.match(styles, /\.sidebar\s*\{[\s\S]*height:\s*100dvh[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /\.conversation-list\s*\{[\s\S]*overflow:\s*visible/);
  const conversationRule = styles.match(/\.conversation-list\s*\{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(conversationRule, /max-height/);
});

test("the desktop lock screen has a narrow, desktop-only exit bridge", () => {
  const login = fs.readFileSync(path.join(root, "public", "login.html"), "utf8");
  const auth = fs.readFileSync(path.join(root, "public", "auth.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
  assert.match(login, /id="exit-app-button"[^>]*hidden/);
  assert.match(auth, /window\.evolvDesktopApp\?\.quit/);
  assert.match(preload, /quit: \(\) => ipcRenderer\.invoke\("app:quit"\)/);
  assert.match(main, /ipcMain\.handle\("app:quit"/);
});

test("Marketplace cards and tabs have complete keyboard interaction contracts", () => {
  assert.match(script, /marketplace-card[^`]*tabindex="0" role="button"/);
  assert.match(script, /\["Enter", " "\]\.includes\(event\.key\)/);
  assert.match(html, /class="marketplace-tabs" role="tablist"/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(script, new RegExp(key));
  assert.match(script, /button\.tabIndex = active \? 0 : -1/);
  assert.match(script, /tabs\[next\]\.focus\(\)/);
});

test("installed packs enter persistent free-form chat instead of requiring a preset command", () => {
  assert.match(script, /class="primary-button marketplace-chat-pack"/);
  assert.match(script, /Free-form pack chat · task inferred from your message/);
  assert.match(script, /packId = app\.activePack\?\.id/);
  assert.match(script, /startNewChat\(\{ preservePack: true/);
  assert.doesNotMatch(script, />Use in chat<\/button>/);
});

test("the generated Evolv brand assets are wired into the shell", () => {
  assert.match(html, /class="brand-logo" src="\/assets\/evolv-logo\.png"/);
  assert.match(html, /class="orb"[^>]*>[\s\S]*\/assets\/evolv-logo\.png/);
  assert.ok(fs.statSync(path.join(root, "public", "assets", "evolv-logo.png")).size > 100_000);
});

test("the circuit identity reacts only to real TTS playback and respects reduced motion", () => {
  assert.match(script, /document\.documentElement\.classList\.toggle\("tts-speaking", active\)/);
  assert.match(script, /utterance\.onstart = \(\) => setSpeakingState\(true\)/);
  assert.match(script, /audio\.onplaying = \(\) => setSpeakingState\(true\)/);
  assert.match(script, /audio\.onended = \(\) => stopSpeech\(\)/);
  assert.doesNotMatch(script, /try \{\s*setSpeakingState\(true\);\s*const result = await window\.evolvDesktopVoice\.synthesize/);
  assert.match(styles, /html\.tts-speaking \.orb/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Marketplace navigation, status, images, and focus are perceivable", () => {
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /id="main-content" class="main" tabindex="-1"/);
  assert.match(html, /id="marketplace-status"[^>]*role="status"/);
  assert.match(html, /id="marketplace-details"[^>]*aria-live="polite"/);
  assert.match(script, /alt="\$\{escapeHtml\(`\$\{pack\.name\} cover artwork`\)\}"/);
  assert.match(styles, /select:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible/);
  assert.match(styles, /\.skip-link:focus/);
});

test("core Marketplace text colors meet WCAG AA contrast on the application background", () => {
  assert.ok(contrast("#f1f3ef", "#090b0b") >= 4.5);
  assert.ok(contrast("#89918d", "#090b0b") >= 4.5);
  assert.ok(contrast("#bdff47", "#090b0b") >= 4.5);
});
