import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import path from "node:path";
import fsPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElectronSecretStore } from "../lib/secrets.mjs";
import { createLogger } from "../lib/logger.mjs";
import { DesktopVoiceService } from "./voice-service.mjs";
import { DesktopVaultHost } from "./vault-host.mjs";
import { DesktopProjectHost } from "./project-host.mjs";
import { DesktopUpdateService } from "./update-service.mjs";

const electronRoot = path.dirname(fileURLToPath(import.meta.url));

// Automated packaged smoke tests use isolated data and may run while the
// owner's normal Evolv window is open. Regular launches still remain single-instance.
const gotLock = process.env.EVOLV_DESKTOP_SMOKE === "1" || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow;
let serverModule;
let voiceService;
let vaultHost;
let projectHost;
let updateService;
let desktopLogger;

function trustedVoiceRequest(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Voice request was rejected.");
}

function registerVoiceBridge() {
  const handle = (channel, handler) => ipcMain.handle(channel, async (event, payload = {}) => {
    trustedVoiceRequest(event);
    return handler(payload);
  });
  handle("voice:status", () => voiceService.status());
  handle("voice:transcribe", ({ audio, options = {} }) => voiceService.transcribeAudio(audio, options));
  handle("voice:synthesize", ({ text = "", rate = 1 }) => voiceService.synthesize(text, rate));
  handle("voice:stop-speaking", () => {
    voiceService.stopSpeaking();
    return { ok: true };
  });
  handle("voice:choose-piper-runtime", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Piper runtime",
      properties: ["openFile"],
      ...(process.platform === "win32"
        ? { filters: [{ name: "Piper runtime", extensions: ["exe"] }] }
        : {})
    });
    if (!result.canceled && result.filePaths[0]) voiceService.configurePiper({ runtime: result.filePaths[0] });
    return voiceService.status();
  });
  handle("voice:choose-piper-model", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Piper voice model",
      defaultPath: app.getPath("downloads"),
      properties: ["openFile"],
      filters: [{ name: "Piper voice model", extensions: ["onnx"] }]
    });
    if (!result.canceled && result.filePaths[0]) voiceService.configurePiper({ model: result.filePaths[0] });
    return voiceService.status();
  });
  handle("voice:choose-whisper-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Whisper.cpp folder",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory"]
    });
    if (!result.canceled && result.filePaths[0]) voiceService.configureWhisperRoot(result.filePaths[0]);
    return voiceService.status();
  });
  handle("voice:choose-whisper-model", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Whisper.cpp speech model",
      defaultPath: app.getPath("downloads"),
      properties: ["openFile"],
      filters: [{ name: "Whisper.cpp model", extensions: ["bin"] }]
    });
    if (!result.canceled && result.filePaths[0]) voiceService.configureWhisperModel(result.filePaths[0]);
    return voiceService.status();
  });
  handle("voice:open-whisper-downloads", async () => {
    await shell.openExternal("https://huggingface.co/ggerganov/whisper.cpp/tree/main");
    return { ok: true };
  });
  handle("voice:open-model-downloads", async () => {
    await shell.openExternal("https://rhasspy.github.io/piper-samples/");
    return { ok: true };
  });
}

function registerVaultBridge() {
  ipcMain.handle("obsidian:choose-vault", async (event) => {
    trustedVoiceRequest(event);
    return vaultHost.chooseVault();
  });
}

function registerProjectBridge() {
  ipcMain.handle("projects:choose-folder", async (event) => {
    trustedVoiceRequest(event);
    return projectHost.chooseProject();
  });
}

function registerAppBridge() {
  ipcMain.handle("app:quit", async (event) => {
    trustedVoiceRequest(event);
    setImmediate(() => app.quit());
    return { ok: true };
  });
  ipcMain.handle("update:status", async (event) => {
    trustedVoiceRequest(event);
    return updateService.status();
  });
  ipcMain.handle("update:check", async (event) => {
    trustedVoiceRequest(event);
    return updateService.check();
  });
  ipcMain.handle("update:download", async (event) => {
    trustedVoiceRequest(event);
    return updateService.download();
  });
  ipcMain.handle("update:install", async (event) => {
    trustedVoiceRequest(event);
    const result = await updateService.prepareInstall();
    setImmediate(() => app.quit());
    return result;
  });
}

async function createWindow() {
  process.env.EVOLV_PORT = "0";
  process.env.EVOLV_DATA_DIR ||= path.join(app.getPath("userData"), "data");
  desktopLogger = createLogger({ dataDir: process.env.EVOLV_DATA_DIR, component: "desktop" });
  delete process.env.EVOLV_DB_PATH;
  globalThis.__EVOLV_SECRET_STORE = createElectronSecretStore(safeStorage);
  updateService = new DesktopUpdateService({
    currentVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    executablePath: process.execPath
  });
  // A Linux update keeps the previous AppImage beside the new one so a failed
  // update can be undone by renaming one file. Reaching this point is proof the
  // new one starts, which is when those 300 MB stop being insurance.
  if (process.env.APPIMAGE) {
    fsPromises.rm(`${process.env.APPIMAGE}.previous`, { force: true })
      .catch((error) => desktopLogger?.warn?.("Could not remove the previous AppImage", { error: error.message }));
  }
  vaultHost = new DesktopVaultHost({
    dialog,
    shell,
    windowProvider: () => mainWindow,
    claimsFile: path.join(app.getPath("userData"), "obsidian-vault-owners.json")
  });
  globalThis.__EVOLV_VAULT_HOST = vaultHost;
  projectHost = new DesktopProjectHost({
    dialog,
    windowProvider: () => mainWindow,
    claimsFile: path.join(app.getPath("userData"), "project-folder-owners.json")
  });
  globalThis.__EVOLV_PROJECT_HOST = projectHost;
  const profileRoot = path.resolve(path.join(process.env.EVOLV_DATA_DIR, "profiles"));
  globalThis.__EVOLV_MARKETPLACE_HOST = Object.freeze({
    async openPackDirectory(directory) {
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(`${profileRoot}${path.sep}`)) throw new Error("Pack directory is outside Evolv profile storage.");
      const result = await shell.openPath(resolved);
      if (result) throw new Error(result);
    },
    async chooseConfigurationPath({ kind, title }) {
      if (!["file", "folder"].includes(kind)) throw new Error("Unsupported Marketplace picker.");
      const result = await dialog.showOpenDialog(mainWindow, {
        title: String(title || (kind === "folder" ? "Choose folder" : "Choose file")).slice(0, 120),
        defaultPath: app.getPath("documents"),
        properties: [kind === "folder" ? "openDirectory" : "openFile"]
      });
      return { canceled: result.canceled, path: result.canceled ? "" : String(result.filePaths[0] || "") };
    },
    async choosePackSourceDirectory() {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Choose Evolv pack source folder",
        defaultPath: app.getPath("documents"),
        properties: ["openDirectory"]
      });
      return { canceled: result.canceled, path: result.canceled ? "" : String(result.filePaths[0] || "") };
    }
  });
  voiceService = new DesktopVoiceService({
    userDataPath: app.getPath("userData"),
    downloadsPath: app.getPath("downloads"),
    whisperRoot: app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "voice-assets", "whisper")
      : path.join(electronRoot, "voice-assets", "whisper"),
    piperRoot: app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "voice-assets", "piper")
      : path.join(electronRoot, "voice-assets", "piper"),
    helperPath: app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "windows-speech.ps1")
      : path.join(electronRoot, "windows-speech.ps1"),
    platform: process.platform
  });
  registerVoiceBridge();
  registerVaultBridge();
  registerProjectBridge();
  registerAppBridge();

  serverModule = await import("../server.mjs");
  const local = await serverModule.ready;
  const origin = local.url;

  // Chromium asks synchronously as well as asynchronously, and a missing
  // check handler answers "no" to the synchronous form — which is what a
  // getUserMedia call sees first.
  // Writing to the clipboard is what a copy button does, and Chromium asks
  // permission for it. Reading the clipboard is deliberately not granted: that
  // is the user's other applications, and paste needs no permission anyway.
  const allowed = ["media", "camera", "microphone", "clipboard-sanitized-write"];

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (requestingOrigin && requestingOrigin !== origin) return false;
    return allowed.includes(permission);
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = new URL(webContents.getURL()).origin;
    const mediaTypes = details?.mediaTypes || [];
    const trustedMedia = permission === "camera" || permission === "microphone"
      || (permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => ["audio", "video"].includes(type)));
    callback(requestingOrigin === origin && (trustedMedia || permission === "clipboard-sanitized-write"));
  });

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#080b0c",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(electronRoot, "preload.cjs")
    }
  });
  voiceService.on("event", (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("voice:event", event);
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    desktopLogger?.error("desktop.renderer-stopped", { reason: details.reason, exitCode: details.exitCode });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  await mainWindow.loadURL(origin);
  mainWindow.show();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(createWindow).catch((error) => {
  desktopLogger?.error("desktop.startup-failed", { error });
  console.error("Evolv desktop failed to start. See the Evolv logs folder for details.");
  app.quit();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  voiceService?.close();
  vaultHost?.close();
  projectHost?.close();
  serverModule?.shutdown?.().catch(() => {});
});
