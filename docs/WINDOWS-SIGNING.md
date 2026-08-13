# Signing the Windows build

Evolv already has a signing pipeline. It is opt-in, because a certificate and a
timestamp service are external credentials that cannot live in a repository.
This is the whole procedure, from buying a certificate to enforcing the gate.

## What signing actually buys

A signature does two things: it proves the build came from you and has not been
altered, and it lets Windows SmartScreen accumulate reputation for *you* rather
than for each individual file. An unsigned build is judged only on how many
people have already run that exact file, which is why a fresh unsigned release
warns everyone who downloads it.

It is not instant. An OV certificate starts with no reputation and earns it
over installs; an EV certificate is granted reputation immediately. That
difference, not the cryptography, is what most of the price gap buys.

## Step 0 — Choose a certificate

Since June 2023 the CA/Browser Forum requires the private key of any
publicly-trusted code signing certificate to live on hardware certified to
FIPS 140-2 Level 2 or equivalent. **You can no longer download a `.pfx` and
sign with a file.** Every option below is a token, an HSM, or a cloud service.

| Route | Cost | SmartScreen | Works in CI |
|---|---|---|---|
| OV certificate on a USB token | ~$200–400/yr | Earns reputation over time | Awkward — the token must be plugged into the machine |
| EV certificate on a USB token or cloud HSM | ~$400–700/yr | Immediate | Cloud HSM yes, USB token no |
| Azure Trusted Signing | ~$10/month | Immediate | Yes, designed for it |

Azure Trusted Signing is the cheapest credible route and the only one that is
pleasant in CI, but it has an identity-validation requirement — historically
three years of verifiable organisation history, with a separate individual
tier. Check the current eligibility rules before committing to it. It also
needs a change to Evolv's signing script: see the last section.

Issuers for the first two rows: DigiCert, Sectigo, GlobalSign, SSL.com.

## Step 1 — Install signtool

`signtool.exe` ships with the Windows SDK, not with Windows.

1. Download the **Windows SDK** installer from Microsoft.
2. Run it and select only **Windows SDK Signing Tools for Desktop Apps**. The
   full SDK is several gigabytes and you need none of the rest.
3. Confirm it landed:

```powershell
Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object FullName -like "*x64*" | Select-Object -ExpandProperty FullName
```

Evolv finds it automatically under `Windows Kits\10\bin\**\x64\`. If yours is
somewhere else, set `SIGNTOOL_PATH` to the full path of `signtool.exe`.

## Step 2 — Install the certificate and read its thumbprint

Install your token's drivers (SafeNet Authentication Client for most USB
tokens), plug it in, then list what Windows can see:

```powershell
Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Thumbprint, NotAfter
```

Copy the 40-character `Thumbprint` of your code signing certificate. That is
how Evolv selects it — `signtool /sha1 <thumbprint>` looks the certificate up
in the store rather than taking a file, which is what makes hardware keys work.

If nothing is listed, the token drivers are not installed or the token is not
plugged in.

## Step 3 — Set the environment

In the PowerShell session you will build from:

```powershell
$env:WINDOWS_SIGN_CERT_SHA1 = "ABCD...40 hex characters, no spaces"
$env:WINDOWS_TIMESTAMP_URL  = "http://timestamp.digicert.com"
```

The timestamp URL must be an RFC 3161 service. Use the one your issuer
publishes — DigiCert's is above; Sectigo uses `http://timestamp.sectigo.com`.

Timestamping is not optional in practice. Without it, every signature you have
ever made stops validating the day the certificate expires. With it, they stay
valid because the timestamp proves the signing happened while the certificate
was live.

## Step 4 — Check readiness before building anything

```powershell
npm run sign:status:win
```

This reports every prerequisite separately — platform, thumbprint format,
timestamp URL, and the resolved `signtool.exe` path — so a missing piece is
named rather than discovered halfway through a build.

Fix anything in `errors` before continuing.

## Step 5 — Build, signed

```powershell
$env:EVOLV_SIGN_WINDOWS = "1"
npm run dist:win
```

Evolv signs `Evolv.exe` and every `.node` native module under
`resources\app.asar.unpacked`, each with SHA-256 and an RFC 3161 timestamp,
then verifies the result before the build is allowed to continue.

A USB token will prompt for its PIN. There are several files to sign, so enable
your token software's single-logon or PIN-caching option first, or you will
type it once per file.

## Step 6 — Verify independently

```powershell
npm run sign:verify:win
```

This asks Windows itself, through `Get-AuthenticodeSignature`, and requires
every target to be `Valid` *and* signed by your thumbprint specifically. A
build signed by the wrong certificate fails here rather than shipping.

You can also check any single file by hand:

```powershell
Get-AuthenticodeSignature .\out\Evolv-win32-x64\Evolv.exe | Format-List
```

## Step 7 — Make it required for releases

Once signing works, turn the warning into a gate:

```powershell
$env:EVOLV_REQUIRE_CODE_SIGNING = "1"
npm run dist:win
```

The build now fails if the executable or any native module is unsigned. Set
this in the release workflow so an unsigned release cannot be published by
accident. Without it, an unsigned build only prints a warning, which is easy to
miss in CI logs.

## Rehearsing without buying anything

You can prove the whole pipeline works before spending money. A self-signed
certificate will **not** satisfy SmartScreen — Windows will still warn, because
nobody trusts your test root — but it exercises every step.

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Evolv Test Signing" -CertStoreLocation Cert:\CurrentUser\My
$cert.Thumbprint
```

Use that thumbprint for `WINDOWS_SIGN_CERT_SHA1` and run steps 4 to 6. Expect
`sign` to succeed and `verify` to report `UnknownError` or `NotTrusted` rather
than `Valid`, since the chain is not trusted — that is the correct outcome for
a test certificate, and it still proves signtool, the thumbprint lookup and the
timestamp service all work.

Remove it afterwards:

```powershell
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"
```

## Two gaps to know about

**The installer is not signed.** `scripts/make-installers.mjs` builds the NSIS
`.exe` after packaging, and nothing signs it. That file is the one people
download and double-click, so it is the one SmartScreen judges hardest — a
signed application inside an unsigned installer still warns on download.
Signing it means running `signtool` over the finished `.exe` in that script,
after `makensis`. The same applies to the AppImage on Linux, which is not
Authenticode-signable at all; there the equivalent is a detached GPG signature
next to the published `.sha256`.

**Azure Trusted Signing needs a different invocation.** It does not use
`signtool /sha1` against a local store; it uses `signtool /dlib` with the
Trusted Signing library and a JSON metadata file, or the `Invoke-TrustedSigning`
PowerShell module. `lib/windows-signing.mjs` would need a second code path
selected by an environment variable. Everything else — the targets, the
verification, the gate — stays as it is.
