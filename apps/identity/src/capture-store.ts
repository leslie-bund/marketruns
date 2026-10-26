import { sha256CaptureHex } from "./crypto.js";

/** Identity-owned, private enrollment captures. No public read or signed-URL seam exists. */
export interface IdentityCaptureStore {
  putPending(key: string, image: Uint8Array, expectedSha256: string): Promise<void>;
  promote(pendingKey: string, currentKey: string, expectedSha256: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function pendingCaptureKey(jobId: string): string {
  return `pending/${jobId}.jpg`;
}

export function currentCaptureKey(jobId: string): string {
  return `enrollments/${jobId}.jpg`;
}

export function createR2CaptureStore(bucket: R2Bucket): IdentityCaptureStore {
  return {
    async putPending(key, image, expectedSha256) {
      if (await sha256CaptureHex(image) !== expectedSha256) throw new Error("capture hash mismatch");
      await bucket.put(key, image, {
        httpMetadata: { contentType: "image/jpeg", cacheControl: "no-store" },
        customMetadata: { sha256: expectedSha256 },
      });
    },
    async promote(pendingKey, currentKey, expectedSha256) {
      const pending = await bucket.get(pendingKey);
      if (!pending) throw new Error("pending capture missing");
      const image = new Uint8Array(await pending.arrayBuffer());
      if (await sha256CaptureHex(image) !== expectedSha256) throw new Error("capture hash mismatch");
      await bucket.put(currentKey, image, {
        httpMetadata: { contentType: "image/jpeg", cacheControl: "no-store" },
        customMetadata: { sha256: expectedSha256 },
      });
      await bucket.delete(pendingKey);
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/** Test/dev adapter with the same hash-binding behavior as the private R2 adapter. */
export function createMemoryCaptureStore(): IdentityCaptureStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putPending(key, image, expectedSha256) {
      if (await sha256CaptureHex(image) !== expectedSha256) throw new Error("capture hash mismatch");
      objects.set(key, new Uint8Array(image));
    },
    async promote(pendingKey, currentKey, expectedSha256) {
      const image = objects.get(pendingKey);
      if (!image || await sha256CaptureHex(image) !== expectedSha256) throw new Error("pending capture missing or changed");
      objects.set(currentKey, new Uint8Array(image));
      objects.delete(pendingKey);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
