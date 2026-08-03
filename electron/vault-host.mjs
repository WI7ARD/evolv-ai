import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The desktop vault host is intentionally tiny. It owns directory-picker
// grants so an authenticated renderer can never submit an arbitrary path to
// the localhost server.
export class DesktopVaultHost {
  constructor({ dialog, shell, windowProvider, claimsFile = "" }) {
    this.dialog = dialog;
    this.shell = shell;
    this.windowProvider = windowProvider;
    this.claimsFile = claimsFile;
    this.grants = new Map();
    this.claims = new Map();
    if (claimsFile) {
      try {
        const stored = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
        for (const [root, profileId] of Object.entries(stored)) {
          if (typeof profileId === "string") this.claims.set(root, profileId);
        }
      } catch { /* first launch or invalid stale metadata */ }
    }
  }

  persistClaims() {
    if (!this.claimsFile) return;
    fs.mkdirSync(path.dirname(this.claimsFile), { recursive: true });
    const temporary = `${this.claimsFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.claims)), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.claimsFile);
  }

  async chooseVault() {
    const result = await this.dialog.showOpenDialog(this.windowProvider(), {
      title: "Choose or create your dedicated Evolv Obsidian vault",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const root = fs.realpathSync.native(path.resolve(result.filePaths[0]));
    const info = fs.statSync(root);
    if (!info.isDirectory()) throw new Error("The selected vault must be a folder.");
    const grant = crypto.randomUUID();
    this.grants.set(grant, { root, expiresAt: Date.now() + 120_000 });
    return { canceled: false, grant, label: path.basename(root) || "Obsidian vault" };
  }

  consumeGrant(grant) {
    const value = this.grants.get(String(grant || ""));
    this.grants.delete(String(grant || ""));
    if (!value || value.expiresAt < Date.now()) throw new Error("The vault selection expired. Choose the folder again.");
    return value.root;
  }

  claimRoot(profileId, root) {
    const canonical = fs.realpathSync.native(path.resolve(root));
    const owner = this.claims.get(canonical.toLowerCase());
    if (owner && owner !== profileId) throw new Error("This vault is already connected to another Evolv profile.");
    this.claims.set(canonical.toLowerCase(), profileId);
    this.persistClaims();
    return canonical;
  }

  releaseRoot(profileId, root) {
    const canonical = path.resolve(root).toLowerCase();
    if (this.claims.get(canonical) === profileId) {
      this.claims.delete(canonical);
      this.persistClaims();
    }
  }

  async openVault(root, relativePath = "") {
    const canonicalRoot = fs.realpathSync.native(path.resolve(root));
    const target = relativePath ? path.resolve(canonicalRoot, relativePath) : canonicalRoot;
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Vault path was rejected.");
    const uri = `obsidian://open?path=${encodeURIComponent(target)}`;
    await this.shell.openExternal(uri);
    return { ok: true };
  }

  close() {
    this.grants.clear();
  }
}
