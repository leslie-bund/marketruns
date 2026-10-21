import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACE_MATCH_THRESHOLD,
  cosineSimilarity,
  faceMatchPasses,
  l2Normalize,
  similarityBucket,
} from "../src/face-match.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("is magnitude-invariant (that is the point of cosine)", () => {
    expect(cosineSimilarity([1, 1], [5, 5])).toBeCloseTo(1);
  });

  it("returns 0 for degenerate zero-norm input instead of NaN", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("rejects length mismatches and non-finite components", () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(RangeError);
    expect(() => cosineSimilarity([Number.NaN, 0], [1, 0])).toThrow(RangeError);
    expect(() => cosineSimilarity([Infinity, 0], [1, 0])).toThrow(RangeError);
  });
});

describe("l2Normalize", () => {
  it("produces a unit vector", () => {
    const n = l2Normalize([3, 4]);
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...n)).toBeCloseTo(1);
  });

  it("passes a zero vector through unchanged", () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});

describe("faceMatchPasses", () => {
  it("defaults to the 0.6 pilot threshold (deliberately above 0.45–0.50 reference stacks)", () => {
    expect(DEFAULT_FACE_MATCH_THRESHOLD).toBe(0.6);
    expect(faceMatchPasses(0.6)).toBe(true);
    expect(faceMatchPasses(0.59)).toBe(false);
    expect(faceMatchPasses(0.59, 0.5)).toBe(true);
  });

  it("fails closed on non-finite scores", () => {
    expect(faceMatchPasses(Number.NaN)).toBe(false);
  });
});

describe("similarityBucket", () => {
  it("bands relative to the threshold and never exposes the raw score", () => {
    expect(similarityBucket(0.1)).toBe("low");
    expect(similarityBucket(0.4)).toBe("medium"); // 0.4 ∈ [0.3, 0.51)
    expect(similarityBucket(0.55)).toBe("high"); // ≥ 0.85 × 0.6
    expect(similarityBucket(Number.NaN)).toBe("low");
  });
});
