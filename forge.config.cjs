const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

module.exports = {
  packagerConfig: {
    asar: { unpack: "**/*.{node,ps1}", unpackDir: "electron/voice-assets" },
    executableName: "Evolv",
    icon: path.join(__dirname, "build", "icon"),
    electronZipDir: process.env.ELECTRON_ZIP_DIR ? path.resolve(process.env.ELECTRON_ZIP_DIR) : undefined,
    ignore: [
      /^\/(?:\.agents|\.codex|\.smoke|build|data|release|scripts|work|outputs|out(?:-[^/]+)?|test|ui-smoke-data|Evolv-Personal-[^/]+|evolv-(?:agent|marketplace|packaged)-smoke-[^/]+)(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/(?:Evolv\.code-workspace|README\.md|forge\.config\.cjs|package-lock\.json|npm-debug\.log)$/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32", "linux"]
    }
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {}
    }
  ],
  hooks: {
    postPackage: async (_forgeConfig, options) => {
      const manifest = options.platform === "linux" ? ".itch-linux.toml" : ".itch.toml";
      for (const outputPath of options.outputPaths) {
        fs.copyFileSync(path.join(__dirname, manifest), path.join(outputPath, ".itch.toml"));
        const executable = path.join(outputPath, options.platform === "win32" ? "Evolv.exe" : "Evolv");
        const asar = path.join(outputPath, "resources", "app.asar");
        const digest = (filename) => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
        const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
        fs.writeFileSync(path.join(outputPath, "release-integrity.json"), `${JSON.stringify({
          schemaVersion: 1,
          version,
          files: {
            [path.basename(executable)]: digest(executable),
            "resources/app.asar": digest(asar)
          }
        }, null, 2)}\n`);
        if (options.platform === "win32" && process.env.EVOLV_SIGN_WINDOWS === "1") {
          execFileSync(process.execPath, [path.join(__dirname, "scripts", "windows-signing.mjs"), "sign", outputPath], { stdio: "inherit" });
        }
        if (options.platform === "win32" && process.env.EVOLV_REQUIRE_CODE_SIGNING === "1") {
          execFileSync(process.execPath, [path.join(__dirname, "scripts", "windows-signing.mjs"), "gate", outputPath], { stdio: "inherit" });
        }
      }
    }
  }
};
