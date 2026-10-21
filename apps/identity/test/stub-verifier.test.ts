import { describe, expect, it } from "vitest";
import { FACE_EMBEDDING_DIMS, cosineSimilarity } from "@market-runs/domain";
import { StubFaceVerifier, createFaceVerifier } from "../src/face-verifier.js";

const image = (fill: number, length = 256) => new Uint8Array(length).fill(fill);

describe("StubFaceVerifier (dev stub — zero security value)", () => {
  const verifier = new StubFaceVerifier();

  it("is deterministic: identical bytes embed identically", async () => {
    const a = await verifier.embed(image(7));
    const b = await verifier.embed(image(7));
    expect(a).toEqual(b);
  });

  it("produces 512 L2-normalized dims", async () => {
    const embedding = await verifier.embed(image(1));
    expect(embedding).toHaveLength(FACE_EMBEDDING_DIMS);
    expect(Math.hypot(...embedding)).toBeCloseTo(1, 6);
  });

  it("gives same-image similarity 1.0 and different-image similarity far below threshold", async () => {
    const a = await verifier.embed(image(42));
    expect(cosineSimilarity(a, await verifier.embed(image(42)))).toBeCloseTo(1, 6);
    const other = cosineSimilarity(a, await verifier.embed(image(43)));
    expect(Math.abs(other)).toBeLessThan(0.3); // independent pseudo-random embeddings
  });

  it("rejects empty images", async () => {
    await expect(verifier.embed(new Uint8Array(0))).rejects.toThrow(RangeError);
  });

  it("is the only selectable implementation; unknown selectors fail loudly", () => {
    expect(createFaceVerifier({})).toBeInstanceOf(StubFaceVerifier);
    expect(createFaceVerifier({ FACE_VERIFIER: "stub" })).toBeInstanceOf(StubFaceVerifier);
    expect(() => createFaceVerifier({ FACE_VERIFIER: "acme-face" })).toThrow(/not implemented/);
  });
});
