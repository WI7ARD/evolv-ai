import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Owns short-lived folder-picker grants. The renderer receives an opaque token,
// never an arbitrary filesystem capability or a canonical path.
export class DesktopProjectHost {
  constructor({ dialog, windowProvider, claimsFile = "" }) {
    this.dialog = dialog;
    this.windowProvider = windowProvider;
    this.claimsFile = claimsFile;
    this.grants = new Map();
    this.claims = new Map();
    if (claimsFile) {
      try {
        const stored = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
        for (const [root, profileId] of Object.entries(stored)) if (typeof profileId === "string") this.claims.set(root, profileId);
      } catch { /* first launch or stale optional metadata */ }
    }
  }

  persistClaims() {
    if (!this.claimsFile) return;
    fs.mkdirSync(path.dirname(this.claimsFile), { recursive: true });
    const temporary = `${this.claimsFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.claims)), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.claimsFile);
  }

  async chooseProject() {
    const result = await this.dialog.showOpenDialog(this.windowProvider(), {
      title: "Choose an Evolv project folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const root = fs.realpathSync.native(path.resolve(result.filePaths[0]));
    if (!fs.statSync(root).isDirectory()) throw new Error("The selected project must be a folder.");
    const grant = crypto.randomUUID();
    this.grants.set(grant, { root, expiresAt: Date.now() + 120_000 });
    return { canceled: false, grant, label: path.basename(root) || "Project folder" };
  }

  consumeGrant(grant) {
    const key = String(grant || "");
    const value = this.grants.get(key);
    this.grants.delete(key);
    if (!value || value.expiresAt < Date.now()) throw new Error("The project-folder selection expired. Choose it again.");
    return value.root;
  }

  claimRoot(profileId, root) {
    const canonical = fs.realpathSync.native(path.resolve(root));
    const key = (process.platform === "win32" ? canonical.toLowerCase() : canonical);
    const owner = this.claims.get(key);
    if (owner && owner !== profileId) throw new Error("This project folder is already connected to another Evolv profile.");
    this.claims.set(key, profileId);
    this.persistClaims();
    return canonical;
  }

  releaseRoot(profileId, root) {
    const resolved = path.resolve(root);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (this.claims.get(key) === profileId) { this.claims.delete(key); this.persistClaims(); }
  }

  close() { this.grants.clear(); }
}
