# `.evolvpack` Format and Manifest Reference

Version 1 uses bounded JSON so packages can be validated without extracting an
untrusted ZIP.

```json
{
  "packageVersion": 1,
  "manifest": {
    "schemaVersion": 1,
    "id": "evolv.example-pack",
    "name": "Example Pack",
    "version": "1.0.0",
    "author": { "name": "Local developer" },
    "description": "Short description.",
    "fullDescription": "Complete purpose and operating model.",
    "category": "productivity",
    "license": "Local development pack",
    "minEvolvVersion": "0.4.0",
    "platforms": ["windows", "linux", "macos"],
    "models": { "local": ["llama"], "cloud": [] },
    "permissions": [
      { "id": "models.local", "required": true, "reason": "Run locally." }
    ],
    "configSchema": { "type": "object", "properties": {} },
    "agents": [],
    "commands": [],
    "workflows": [],
    "examples": [],
    "features": [],
    "documentation": "# Example Pack",
    "knowledge": []
  },
  "files": {
    "README.md": "# Example Pack",
    "CHANGELOG.md": "1.0.0 — Initial version."
  }
}
```

## Rules

- Pack IDs match `evolv.<lowercase-name>`.
- Agent, command, and workflow IDs use lowercase kebab case.
- Versions use semantic versioning.
- Commands may reference only an agent in the same manifest.
- Supported configuration types are string, number, boolean, and string array.
- String formats are `secret`, `file`, `folder`, and `model`.
- Secret fields cannot define defaults and are encrypted separately.
- Files must be bounded text at safe relative paths and cannot duplicate
  `manifest.json`.

Executable code, absolute paths, symbolic links, package installation, and
installation hooks are unsupported.

## Publisher identity and signatures

Unsigned local development packs remain installable after the normal permission
review, but they are always labeled **Unsigned**. A manifest's `verified` field is
ignored; a package cannot award itself a verified badge.

Signed packages add top-level `publisher` and `signature` objects. `publisher`
contains `id`, `name`, and an Ed25519 PEM `publicKey`. `signature` contains
`algorithm: "Ed25519"`, the `ed25519:<sha256-spki>` `keyId`, and a base64
signature value.

The signature covers canonical JSON containing only `packageVersion`, the
normalized `manifest`, and `files`. Object keys are sorted recursively; derived
`verified` and `publisherVerification` fields are excluded.

A valid signature proves that a package has not changed since that key signed it.
It does not prove who owns the key. Evolv labels it **Signed · publisher not
trusted** until the user explicitly trusts its fingerprint. Trust can be revoked,
and an invalid or partially specified signature blocks installation.

The permission registry in `lib/marketplace.mjs` covers filesystem, terminal,
network, models, application context, and hardware. Declaring a permission does
not implement it. Unrestricted terminal access is modeled for forward
compatibility but never executed by the declarative runtime.

## Pack developer CLI and live reload

The local CLI uses the exact same validator as the application:

```powershell
npm run pack:validate -- .\my-pack
npm run pack:build -- .\my-pack --output .\dist\my-pack.evolvpack
npm run pack:watch -- .\my-pack --output .\dist\my-pack.evolvpack
node .\scripts\evolv-pack.mjs keygen --output .\keys\my-publisher
node .\scripts\evolv-pack.mjs sign .\dist\my-pack.evolvpack --private-key .\keys\my-publisher.private.pem --publisher-id my-publisher --publisher-name "My Publisher" --output .\dist\my-pack-signed.evolvpack
```

A source folder contains `manifest.json` at its root and bounded text files
beneath it. Hidden files and folders are ignored; symbolic links, binary data,
oversized files, unsafe paths, and invalid manifests are rejected. Build output
is replaced atomically only after validation. Key generation refuses to
overwrite existing key files.

In the desktop app, enable Marketplace Developer Mode, install the pack once,
then choose **Watch source folder** on its detail page. Reloads are validation
gated and cannot add a permission that was not already approved. Invalid changes
leave the last valid installed version running and surface the validation error.
The selected source path is held only by the desktop process and is not returned
to the browser UI.
