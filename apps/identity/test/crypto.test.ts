import { describe, expect, it } from "vitest";
import { FACE_EMBEDDING_DIMS } from "@market-runs/domain";
import { DEV_ENCRYPTION_KEY_BASE64 } from "../src/env.js";
import { decryptEmbedding, encryptEmbedding, sha256Hex } from "../src/crypto.js";

function embedding(seed = 1): number[] {
  return Array.from({ length: FACE_EMBEDDING_DIMS }, (_, i) => Math.sin(i * seed));
}

describe("embedding encryption (AES-256-GCM, WebCrypto)", () => {
  it("round-trips a 512-dim embedding", async () => {
    const original = embedding();
    const encrypted = await encryptEmbedding(original, DEV_ENCRYPTION_KEY_BASE64);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext).toHaveLength(FACE_EMBEDDING_DIMS * 4);
    const decrypted = await decryptEmbedding(encrypted, DEV_ENCRYPTION_KEY_BASE64);
    for (let i = 0; i < FACE_EMBEDDING_DIMS; i += 1) {
      expect(decrypted[i]).toBeCloseTo(original[i]!, 6);
    }
  });

  it("uses a random IV per encryption (no nonce reuse by construction)", async () => {
    const a = await encryptEmbedding(embedding(), DEV_ENCRYPTION_KEY_BASE64);
    const b = await encryptEmbedding(embedding(), DEV_ENCRYPTION_KEY_BASE64);
    expect([...a.iv]).not.toEqual([...b.iv]);
    expect([...a.ciphertext]).not.toEqual([...b.ciphertext]);
  });

  it("fails to decrypt under a different key or with a tampered tag (GCM authentication)", async () => {
    const encrypted = await encryptEmbedding(embedding(), DEV_ENCRYPTION_KEY_BASE64);
    const otherKey = btoa("another-dev-key-which-is-32byte"); // exactly 32 bytes
    await expect(decryptEmbedding(encrypted, otherKey)).rejects.toThrow();
    const tampered = { ...encrypted, authTag: encrypted.authTag.map((b) => b ^ 0xff) };
    await expect(decryptEmbedding(tampered, DEV_ENCRYPTION_KEY_BASE64)).rejects.toThrow();
  });

  it("rejects wrong-length inputs and bad keys", async () => {
    await expect(encryptEmbedding([1, 2, 3], DEV_ENCRYPTION_KEY_BASE64)).rejects.toThrow(RangeError);
    await expect(encryptEmbedding(embedding(), btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});

describe("sha256Hex", () => {
  it("is deterministic and hex-shaped", async () => {
    const hash = await sha256Hex("device-secret");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("device-secret")).toBe(hash);
    expect(await sha256Hex("other")).not.toBe(hash);
  });
});
