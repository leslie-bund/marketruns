import { FACE_EMBEDDING_DIMS } from "@market-runs/domain";

/**
 * Embedding encryption at rest — AES-256-GCM, WebCrypto only (no
 * node:crypto; Workers runtime).
 *
 * Layout on disk (face_enrollments): ciphertext | iv | auth_tag in separate
 * bytea columns. WebCrypto's AES-GCM returns ciphertext+tag concatenated;
 * we split the trailing 16 bytes into auth_tag so tampering is visible in
 * the storage shape, and re-append before decrypt.
 *
 * CONSEQUENCE (recorded in the schema too): encrypted embeddings are opaque
 * to pgvector's `<=>` index, so verification decrypts the participant's
 * single enrollment row and compares in memory. Fine at pilot scale; the
 * indexed path back is documented on the table.
 */

const TAG_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedEmbedding {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array([...atob(keyBase64)].map((ch) => ch.charCodeAt(0)));
  } catch {
    throw new Error("IDENTITY_ENCRYPTION_KEY must be base64-encoded 32 bytes");
  }
  if (raw.length !== 32) {
    throw new Error(`IDENTITY_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptEmbedding(embedding: readonly number[], keyBase64: string): Promise<EncryptedEmbedding> {
  if (embedding.length !== FACE_EMBEDDING_DIMS) {
    throw new RangeError(`embedding must be ${FACE_EMBEDDING_DIMS} dims, got ${embedding.length}`);
  }
  const plaintext = new Float32Array(embedding);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(keyBase64);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  return {
    ciphertext: sealed.slice(0, sealed.length - TAG_BYTES),
    iv,
    authTag: sealed.slice(sealed.length - TAG_BYTES),
  };
}

export async function decryptEmbedding(encrypted: EncryptedEmbedding, keyBase64: string): Promise<number[]> {
  const key = await importKey(keyBase64);
  const sealed = new Uint8Array(encrypted.ciphertext.length + encrypted.authTag.length);
  sealed.set(encrypted.ciphertext, 0);
  sealed.set(encrypted.authTag, encrypted.ciphertext.length);
  // Throws (OperationError) on tampered ciphertext/tag — GCM authentication.
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encrypted.iv as BufferSource }, key, sealed);
  const floats = new Float32Array(plain);
  if (floats.length !== FACE_EMBEDDING_DIMS) {
    throw new Error(`decrypted embedding has ${floats.length} dims, expected ${FACE_EMBEDDING_DIMS}`);
  }
  return [...floats];
}

/** SHA-256 hex — for device-key secrets at rest (the raw secret is never stored). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
