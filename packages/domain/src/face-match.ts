/**
 * Face-match math — PURE (packages/domain doctrine: no platform imports).
 *
 * The identity worker (apps/identity) embeds a facial capture through the
 * vendor-neutral FaceVerifier seam (ADR-0009) and compares it against the
 * enrolled embedding with cosine similarity over L2-normalized 512-dim
 * vectors. This module is that comparison, nothing else: no I/O, no crypto,
 * no vendor names.
 *
 * Threshold doctrine: the default is deliberately higher than the 0.45–0.50
 * seen in reference stacks that shipped without benchmarking. 0.6 is a
 * conservative pilot default for a same-model embedding space; it is
 * env-tunable at the worker (FACE_MATCH_THRESHOLD) and MUST be revisited
 * against real-vendor benchmark data before launch — a threshold chosen
 * without measured FAR/FRR is a placeholder, not a security control.
 */

export const FACE_EMBEDDING_DIMS = 512;
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.6;

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate (zero-norm) input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new RangeError("cosineSimilarity: non-finite component");
    }
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** L2-normalize a vector in place into a new array; a zero vector normalizes to itself. */
export function l2Normalize(v: readonly number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  const length = Math.sqrt(norm);
  if (length === 0) return [...v];
  return v.map((x) => x / length);
}

/** The accept decision. `threshold` defaults to the pilot value above. */
export function faceMatchPasses(similarity: number, threshold: number = DEFAULT_FACE_MATCH_THRESHOLD): boolean {
  if (!Number.isFinite(similarity)) return false;
  return similarity >= threshold;
}

/**
 * Banded similarity for wire responses and audit rows. The raw score is
 * NEVER returned to the caller: a live score oracle lets an attacker
 * hill-climb a synthetic image toward the threshold. Bands give the client
 * enough to message "move closer / better light" without that oracle.
 * Bands are relative to the threshold, so retuning the threshold retunes
 * the bands.
 */
export type SimilarityBucket = "low" | "medium" | "high";

export function similarityBucket(
  similarity: number,
  threshold: number = DEFAULT_FACE_MATCH_THRESHOLD,
): SimilarityBucket {
  if (!Number.isFinite(similarity) || similarity < threshold * 0.5) return "low";
  if (similarity < threshold * 0.85) return "medium";
  return "high";
}
