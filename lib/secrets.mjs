export function createUnavailableSecretStore() {
  return {
    available: false,
    description: "Cloud API keys are available in the Evolv desktop app.",
    async encrypt() {
      throw Object.assign(new Error(this.description), { status: 503, code: "SECRET_STORE_UNAVAILABLE" });
    },
    async decrypt() {
      throw Object.assign(new Error(this.description), { status: 503, code: "SECRET_STORE_UNAVAILABLE" });
    }
  };
}

export function createElectronSecretStore(safeStorage, platform = process.platform) {
  // Electron exposes async safeStorage APIs (encryptStringAsync /
  // isAsyncEncryptionAvailable) only in newer releases; Electron 37 has just the
  // synchronous ones. Prefer async when present, otherwise fall back to sync so
  // key storage works across Electron versions.
  const hasAsync = typeof safeStorage.isAsyncEncryptionAvailable === "function"
    && typeof safeStorage.encryptStringAsync === "function"
    && typeof safeStorage.decryptStringAsync === "function";

  const backend = typeof safeStorage.getSelectedStorageBackend === "function"
    ? String(safeStorage.getSelectedStorageBackend() || "")
    : "";
  const insecureLinuxBackend = platform === "linux" && backend === "basic_text";
  const platformDescription = platform === "win32"
    ? "Protected by Windows DPAPI."
    : platform === "darwin"
      ? "Protected by macOS Keychain."
      : "Protected by the Linux desktop keyring.";

  function unavailable() {
    const message = insecureLinuxBackend
      ? "Cloud API keys are disabled because no secure Linux keyring is available."
      : "Operating-system secure storage is temporarily unavailable.";
    return Object.assign(new Error(message), { status: 503, code: "SECRET_STORE_UNAVAILABLE" });
  }

  return {
    available: !insecureLinuxBackend,
    description: insecureLinuxBackend
      ? "Install or unlock a Secret Service keyring before saving cloud API keys."
      : platformDescription,
    async encrypt(value) {
      if (insecureLinuxBackend) throw unavailable();
      if (hasAsync) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw unavailable();
        const result = await safeStorage.encryptStringAsync(String(value));
        return Buffer.from(result.encryptedData ?? result).toString("base64");
      }
      if (!safeStorage.isEncryptionAvailable()) throw unavailable();
      return safeStorage.encryptString(String(value)).toString("base64");
    },
    async decrypt(value) {
      if (!value) return "";
      if (insecureLinuxBackend) throw unavailable();
      const buffer = Buffer.from(value, "base64");
      if (hasAsync) {
        const result = await safeStorage.decryptStringAsync(buffer);
        if (result.isTemporarilyUnavailable) throw unavailable();
        return result.decryptedString;
      }
      return safeStorage.decryptString(buffer);
    }
  };
}
