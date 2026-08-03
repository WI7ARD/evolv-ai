# Evolv on Linux Mint

This build targets 64-bit Linux Mint and keeps the same local accounts,
conversations, SQLite storage, AI providers, tools, and Obsidian memory as the
Windows desktop app.

## Run the packaged app

1. Extract `Evolv-linux-x64-<version>.tar.gz`.
2. Open the extracted `Evolv-linux-x64` folder.
3. Right-click `Evolv`, open **Properties → Permissions**, and allow executing
   the file if Mint has removed that permission.
4. Double-click `Evolv`, or run `./Evolv` from a terminal inside the folder.

Evolv stores this Linux profile under the current user's application-data
folder. It still binds only to a random `127.0.0.1` port.

## Build it on Linux Mint

Install Node.js 20 or newer and the desktop keyring library, then run:

```bash
sudo apt install libsecret-1-0
npm install
npm test
npm run dist:linux
```

The portable folder is `out/Evolv-linux-x64`. The uploadable archive is:

```text
out/make/tar/linux/x64/Evolv-linux-x64-0.4.0.tar.gz
```

The release command deliberately refuses to create the Linux artifact on
Windows. Building on Mint guarantees that `better-sqlite3` is a Linux binary
and preserves the launcher's executable permission.

## Cloud API keys

Electron encrypts keys through Mint's Secret Service-compatible desktop
keyring. Evolv disables key saving if Electron reports its insecure
`basic_text` fallback. Unlock the normal Mint login keyring and restart Evolv
if provider credentials are unavailable. Keys never enter portable exports.

## Local voice

The Windows `.exe` voice engines are intentionally excluded.

- Whisper.cpp: download or build the Linux x64 version, then choose its folder
  in **Settings → Local desktop voice → Choose Whisper folder**. Evolv looks for
  `whisper-cli` in `build/bin`, `bin`, `Release`, or the selected folder. The
  packaged `ggml-base.en.bin` model is reused automatically.
- Piper: download a Linux x64 Piper runtime, make the `piper` file executable,
  and choose it in Settings. Choose a matching `.onnx` voice; its
  `.onnx.json` file must be beside it.

If Mint blocks a downloaded engine, open a terminal in its folder and run:

```bash
chmod +x piper whisper-cli whisper-stream
```

Push-to-talk remains local. There is no wake word or background listening.

## Ollama and Obsidian

Install Ollama for Linux separately if you want local models. Evolv connects to
`http://127.0.0.1:11434` as before. Obsidian vault selection and
`obsidian://` links work through the Linux desktop app.

## itch.io

The Linux package contains its own `.itch.toml` pointing to the extensionless
`Evolv` launcher.

```bash
npm run dist:linux
npm run itch:validate:linux
export ITCH_USER="your-itch-username"
export ITCH_PROJECT="evolv"
npm run itch:push:linux
```

This pushes the portable folder to the itch.io `linux` channel. The Windows
manifest, package, and `windows` channel are unchanged.
