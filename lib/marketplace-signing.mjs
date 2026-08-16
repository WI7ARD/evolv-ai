import crypto from "node:crypto";

const MAX_PUBLIC_KEY_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 256;
const PUBLISHER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const KEY_ID = /^ed25519:[a-f0-9]{64}$/;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function signingError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw signingError("Signed package data must contain only finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw signingError("Signed package data contains an unsupported value.");
}

function publicKeyObject(publicKey) {
  const source = String(publicKey || "").trim();
  if (!source || Buffer.byteLength(source) > MAX_PUBLIC_KEY_BYTES) throw signingError("Publisher public key is missing or too large.");
  let key;
  try {
    key = crypto.createPublicKey(source);
  } catch {
    throw signingError("Publisher public key is not valid PEM.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw signingError("Publisher public key must use Ed25519.");
  return key;
}

export function publisherKeyId(publicKey) {
  const key = publicKeyObject(publicKey);
  const der = key.export({ type: "spki", format: "der" });
  return `ed25519:${crypto.createHash("sha256").update(der).digest("hex")}`;
}

export function packageSigningPayload(packPackage) {
  const manifest = structuredClone(packPackage.manifest);
  delete manifest.verified;
  delete manifest.publisherVerification;
  return Buffer.from(canonicalJson({
    packageVersion: packPackage.packageVersion,
    manifest,
    files: packPackage.files
  }), "utf8");
}

export function normalizePublisher(raw) {
  if (!plainObject(raw)) throw signingError("Signed packages require a publisher identity.");
  const id = String(raw.id || "").trim().toLowerCase();
  const name = String(raw.name || "").trim().slice(0, 120);
  const publicKey = String(raw.publicKey || "").trim();
  if (!PUBLISHER_ID.test(id) || id.length > 100 || !name) throw signingError("Publisher identity is invalid.");
  const keyId = publisherKeyId(publicKey);
  return { id, name, keyId, publicKey };
}

export function verifyPackSignature(packPackage, { trustedKeyIds = [] } = {}) {
  const hasPublisher = packPackage.publisher !== undefined;
  const hasSignature = packPackage.signature !== undefined;
  if (!hasPublisher && !hasSignature) {
    return {
      state: "unsigned",
      valid: false,
      trusted: false,
      keyId: "",
      publisher: null
    };
  }
  if (!hasPublisher || !hasSignature || !plainObject(packPackage.signature)) {
    throw signingError("The package has incomplete publisher signature metadata.");
  }
  const publisher = normalizePublisher(packPackage.publisher);
  const algorithm = String(packPackage.signature.algorithm || "");
  const declaredKeyId = String(packPackage.signature.keyId || "").toLowerCase();
  const encoded = String(packPackage.signature.value || "");
  if (algorithm !== "Ed25519" || !KEY_ID.test(declaredKeyId) || declaredKeyId !== publisher.keyId) {
    throw signingError("The package signature identity does not match its publisher key.");
  }
  let signature;
  try {
    signature = Buffer.from(encoded, "base64");
  } catch {
    throw signingError("The package signature is not valid base64.");
  }
  if (!signature.length || signature.length > MAX_SIGNATURE_BYTES || signature.toString("base64") !== encoded) {
    throw signingError("The package signature encoding is invalid.");
  }
  const valid = crypto.verify(null, packageSigningPayload(packPackage), publicKeyObject(publisher.publicKey), signature);
  if (!valid) throw signingError("Pack signature verification failed. The package may have been changed.");
  const trusted = new Set(trustedKeyIds).has(publisher.keyId);
  return {
    state: trusted ? "trusted" : "signed",
    valid: true,
    trusted,
    keyId: publisher.keyId,
    publisher: { id: publisher.id, name: publisher.name }
  };
}

export function verifySignedEnvelope(raw, { trustedKeyIds = [] } = {}) {
  if (!plainObject(raw) || raw.payload === undefined || !plainObject(raw.signature)) {
    throw signingError("Signed response envelope is invalid.");
  }
  const publisher = normalizePublisher(raw.publisher);
  const signature = raw.signature;
  if (signature.algorithm !== "Ed25519" || String(signature.keyId || "").toLowerCase() !== publisher.keyId) {
    throw signingError("Signed response identity does not match its publisher key.");
  }
  const encoded = String(signature.value || "");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES || bytes.toString("base64") !== encoded) {
    throw signingError("Signed response encoding is invalid.");
  }
  if (!crypto.verify(null, Buffer.from(canonicalJson(raw.payload)), publicKeyObject(publisher.publicKey), bytes)) {
    throw signingError("Signed response verification failed.");
  }
  if (!new Set(trustedKeyIds).has(publisher.keyId)) {
    throw Object.assign(new Error(`Response publisher is not trusted: ${publisher.keyId}`), { status: 403 });
  }
  return {
    payload: raw.payload,
    verification: {
      state: "trusted", valid: true, trusted: true, keyId: publisher.keyId,
      publisher: { id: publisher.id, name: publisher.name }
    }
  };
}

export function signPackPackage(packPackage, { publisher, privateKey }) {
  const normalizedPublisher = normalizePublisher(publisher);
  let key;
  try {
    key = crypto.createPrivateKey(privateKey);
  } catch {
    throw signingError("Publisher private key is not valid PEM.");
  }
  if (key.asymmetricKeyType !== "ed25519") throw signingError("Publisher private key must use Ed25519.");
  const matchingId = publisherKeyId(crypto.createPublicKey(key).export({ type: "spki", format: "pem" }));
  if (matchingId !== normalizedPublisher.keyId) throw signingError("Publisher private key does not match the public key.");
  const payload = {
    packageVersion: packPackage.packageVersion,
    manifest: packPackage.manifest,
    files: packPackage.files,
    publisher: normalizedPublisher
  };
  const signature = crypto.sign(null, packageSigningPayload(payload), key);
  return {
    ...payload,
    signature: {
      algorithm: "Ed25519",
      keyId: normalizedPublisher.keyId,
      value: signature.toString("base64")
    }
  };
}
