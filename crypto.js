// js/crypto.js
//
// Mirrors app/src/.../crypto/CryptoEngine.java exactly, using the browser's
// native Web Crypto API, so messages encrypted here can be decrypted by the
// Android app and vice versa:
//
//   Key exchange  : X25519 (Curve25519 Diffie-Hellman)   — raw 32-byte keys
//   Symmetric enc : AES-256-GCM, 12-byte IV, 128-bit tag
//   KDF           : SHA-256 of the raw shared secret -> 256-bit AES key
//   Wire format   : [12-byte IV][ciphertext+tag]           (identical to Android)
//
// REQUIRES a browser with native X25519 support in crypto.subtle
// (current Chrome, Edge, and Firefox all support this; see FIRESTORE_SETUP.md
// "Browser requirements" if yours doesn't).

import { idb } from "./idb.js";

function assertX25519Support() {
  if (!("subtle" in crypto)) {
    throw new Error("This browser has no Web Crypto API. Use a modern Chrome, Edge, or Firefox.");
  }
}

// ─── Key Pair Generation ─────────────────────────────────────────────────

export async function generateAndStoreKeyPair() {
  assertX25519Support();
  const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  await idb.put("keys", keyPair.privateKey, "privateKey");
  await idb.put("keys", keyPair.publicKey, "publicKey");
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return toBase64(new Uint8Array(rawPublic));
}

export async function getStoredKeyPair() {
  const privateKey = await idb.get("keys", "privateKey");
  const publicKey = await idb.get("keys", "publicKey");
  if (!privateKey || !publicKey) return null;
  return { privateKey, publicKey };
}

export async function getOrCreatePublicKeyBase64() {
  const existing = await getStoredKeyPair();
  if (existing) {
    const rawPublic = await crypto.subtle.exportKey("raw", existing.publicKey);
    return toBase64(new Uint8Array(rawPublic));
  }
  return generateAndStoreKeyPair();
}

// ─── Shared Key Derivation (per-contact, cached in IndexedDB) ────────────

export async function deriveSharedKey(theirPublicKeyBase64) {
  const cached = await idb.get("sessionKeys", theirPublicKeyBase64);
  if (cached) return cached;

  const { privateKey } = await getStoredKeyPair();
  if (!privateKey) throw new Error("No local keypair yet — call generateAndStoreKeyPair() first.");

  const theirRawBytes = fromBase64(theirPublicKeyBase64);
  const theirPublicKey = await crypto.subtle.importKey(
    "raw",
    theirRawBytes,
    { name: "X25519" },
    true,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPublicKey },
    privateKey,
    256
  );

  // KDF: SHA-256 of the raw shared secret -> 256-bit AES key (matches Android)
  const digest = await crypto.subtle.digest("SHA-256", sharedBits);
  const aesKey = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

  await idb.put("sessionKeys", aesKey, theirPublicKeyBase64);
  return aesKey;
}

// ─── AES-256-GCM Encrypt / Decrypt ────────────────────────────────────────
// Wire format: [12-byte IV][ciphertext+tag] — identical to CryptoEngine.java

const GCM_IV_LENGTH = 12;
const GCM_TAG_BITS = 128;

export async function encryptText(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: GCM_TAG_BITS },
    aesKey,
    encoded
  );
  const combined = new Uint8Array(GCM_IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), GCM_IV_LENGTH);
  return toBase64(combined);
}

export async function decryptText(aesKey, base64Ciphertext) {
  const combined = fromBase64(base64Ciphertext);
  const iv = combined.slice(0, GCM_IV_LENGTH);
  const ciphertext = combined.slice(GCM_IV_LENGTH);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: GCM_TAG_BITS },
    aesKey,
    ciphertext
  );
  return new TextDecoder().decode(plainBuf);
}

export async function encryptBytes(aesKey, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: GCM_TAG_BITS },
    aesKey,
    bytes
  );
  const combined = new Uint8Array(GCM_IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), GCM_IV_LENGTH);
  return combined;
}

export async function decryptBytes(aesKey, combinedBytes) {
  const iv = combinedBytes.slice(0, GCM_IV_LENGTH);
  const ciphertext = combinedBytes.slice(GCM_IV_LENGTH);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: GCM_TAG_BITS },
    aesKey,
    ciphertext
  );
  return new Uint8Array(plainBuf);
}

// ─── Base64 helpers (Base64.NO_WRAP equivalent) ───────────────────────────

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
