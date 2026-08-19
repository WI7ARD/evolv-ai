const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed Electron preload scripts use the restricted CommonJS loader.
// Expose only narrow voice operations; the renderer never receives filesystem,
// process, or unrestricted IPC access.
contextBridge.exposeInMainWorld("evolvDesktopVoice", Object.freeze({
  status: () => ipcRenderer.invoke("voice:status"),
  transcribe: (audio, options = {}) => ipcRenderer.invoke("voice:transcribe", { audio, options }),
  synthesize: (text, options = {}) => ipcRenderer.invoke("voice:synthesize", { text, ...options }),
  stopSpeaking: () => ipcRenderer.invoke("voice:stop-speaking"),
  choosePiperRuntime: () => ipcRenderer.invoke("voice:choose-piper-runtime"),
  choosePiperModel: () => ipcRenderer.invoke("voice:choose-piper-model"),
  chooseWhisperFolder: () => ipcRenderer.invoke("voice:choose-whisper-folder"),
  chooseWhisperModel: () => ipcRenderer.invoke("voice:choose-whisper-model"),
  openWhisperDownloads: () => ipcRenderer.invoke("voice:open-whisper-downloads"),
  openModelDownloads: () => ipcRenderer.invoke("voice:open-model-downloads")
}));

contextBridge.exposeInMainWorld("evolvObsidian", Object.freeze({
  chooseVault: () => ipcRenderer.invoke("obsidian:choose-vault")
}));

contextBridge.exposeInMainWorld("evolvProjects", Object.freeze({
  chooseFolder: () => ipcRenderer.invoke("projects:choose-folder")
}));

// The locked renderer has no Node access. Expose only the safe desktop action
// it needs so a user can close Evolv without signing in.
contextBridge.exposeInMainWorld("evolvDesktopApp", Object.freeze({
  quit: () => ipcRenderer.invoke("app:quit"),
  updateStatus: () => ipcRenderer.invoke("update:status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  reclaimUpdateSpace: () => ipcRenderer.invoke("update:reclaim")
}));
