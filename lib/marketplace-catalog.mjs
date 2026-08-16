import crypto from "node:crypto";
import { canonicalJson, normalizePublisher } from "./marketplace-signing.mjs";

const MAX_CATALOG_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGES = 500;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function publicKeyObject(publicKey) {
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw error("Catalog publisher key must use Ed25519.");
  return key;
}

export function validateCatalogUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw error("Enter a valid catalog URL.");
  }
  if (url.username || url.password || url.hash) throw error("Catalog URLs cannot contain credentials or fragments.");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw error("Remote catalogs require HTTPS. HTTP is allowed only on loopback.");
  }
  return url.toString();
}

export function verifySignedCatalog(raw, { trustedKeyIds = [] } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.catalogVersion !== 1 || !Array.isArray(raw.packages)) {
    throw error("Remote catalog format is invalid.");
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_CATALOG_BYTES || raw.packages.length > MAX_PACKAGES) {
    throw error("Remote catalog exceeds the allowed size.", 413);
  }
  const publisher = normalizePublisher(raw.publisher);
  const signature = raw.signature;
  if (!signature || signature.algorithm !== "Ed25519" || signature.keyId !== publisher.keyId) {
    throw error("Remote catalog signature identity is invalid.");
  }
  let bytes;
  try {
    bytes = Buffer.from(String(signature.value || ""), "base64");
  } catch {
    throw error("Remote catalog signature is not valid base64.");
  }
  if (!bytes.length || bytes.toString("base64") !== signature.value) throw error("Remote catalog signature encoding is invalid.");
  const payload = Buffer.from(canonicalJson({
    catalogVersion: 1,
    generatedAt: String(raw.generatedAt || ""),
    expiresAt: String(raw.expiresAt || ""),
    packages: raw.packages
  }));
  if (!crypto.verify(null, payload, publicKeyObject(publisher.publicKey), bytes)) {
    throw error("Remote catalog signature verification failed.");
  }
  if (!new Set(trustedKeyIds).has(publisher.keyId)) {
    throw error(`Catalog publisher is signed but not trusted: ${publisher.keyId}`, 403);
  }
  const generatedAt = new Date(raw.generatedAt);
  const expiresAt = new Date(raw.expiresAt);
  if (!Number.isFinite(generatedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= generatedAt) {
    throw error("Remote catalog timestamps are invalid.");
  }
  if (expiresAt.getTime() < Date.now()) throw error("Remote catalog has expired.", 409);
  return {
    catalogVersion: 1,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    packages: raw.packages,
    publisher: { id: publisher.id, name: publisher.name, keyId: publisher.keyId }
  };
}

export async function fetchSignedCatalog(url, { trustedKeyIds = [], etag = "", fetchImpl = fetch } = {}) {
  const validatedUrl = validateCatalogUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(validatedUrl, {
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(etag ? { "if-none-match": etag } : {})
      }
    });
    if (response.status === 304) return { notModified: true, etag };
    if (!response.ok) throw error(`Catalog request failed with HTTP ${response.status}.`, 502);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) throw error("Catalog response must be application/json.", 502);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_CATALOG_BYTES) throw error("Remote catalog exceeds the allowed size.", 413);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw error("Remote catalog exceeds the allowed size.", 413);
    let raw;
    try { raw = JSON.parse(text); } catch { throw error("Remote catalog returned malformed JSON.", 502); }
    return {
      catalog: verifySignedCatalog(raw, { trustedKeyIds }),
      raw,
      etag: String(response.headers.get("etag") || "").slice(0, 500)
    };
  } catch (caught) {
    if (caught?.name === "AbortError") throw error("Remote catalog request timed out.", 504);
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}
