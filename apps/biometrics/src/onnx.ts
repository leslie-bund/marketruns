import sharp from "sharp";
import type { BiometricModel, LivenessVerdict } from "./service.js";

/** ArcFace 112×112 RGB NCHW preprocessing, adapted from bug-free-giggle/recognition/embedder.ts. */
async function pixels(image: Buffer, size: number, bgr: boolean): Promise<Float32Array> {
  const { data } = await sharp(image).resize(size, size, { fit: "cover", position: "centre" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const count = size * size; const output = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = data[i * 3]!, g = data[i * 3 + 1]!, b = data[i * 3 + 2]!;
    output[i] = bgr ? b : (r - 127.5) / 127.5;
    output[count + i] = bgr ? g : (g - 127.5) / 127.5;
    output[count * 2 + i] = bgr ? r : (b - 127.5) / 127.5;
  }
  return output;
}
function normalize(values: Float32Array): Float32Array {
  let sum = 0; for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum); if (norm === 0) throw new Error("zero embedding");
  return Float32Array.from(values, (v) => v / norm);
}
function softmax(logits: Float32Array): number[] {
  const max = Math.max(...logits); const exps = [...logits].map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0); return exps.map((v) => v / sum);
}

export interface OnnxConfig { faceModelPath: string; livenessModelPath: string; livenessThreshold: number }
export class OnnxBiometricModel implements BiometricModel {
  readonly modelVersion = "arcface-w600k-r50+minifasnet-v2";
  private faceSession: import("onnxruntime-node").InferenceSession | null = null;
  private liveSession: import("onnxruntime-node").InferenceSession | null = null;
  constructor(private readonly config: OnnxConfig) {}
  private async sessions() {
    const ort = await import("onnxruntime-node");
    this.faceSession ??= await ort.InferenceSession.create(this.config.faceModelPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
    this.liveSession ??= await ort.InferenceSession.create(this.config.livenessModelPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
    return { ort, face: this.faceSession, live: this.liveSession };
  }
  async embed(image: Buffer): Promise<Float32Array> {
    const { ort, face } = await this.sessions();
    const input = new ort.Tensor("float32", await pixels(image, 112, false), [1, 3, 112, 112]);
    const result = await face.run({ [face.inputNames[0]!]: input });
    const output = result[face.outputNames[0]!]!.data as Float32Array;
    if (output.length !== 512) throw new Error(`ArcFace returned ${output.length} dimensions, expected 512`);
    return normalize(output);
  }
  async liveness(frames: Buffer[]): Promise<LivenessVerdict> {
    const { ort, live } = await this.sessions(); const scores: number[] = [];
    for (const frame of frames) {
      const input = new ort.Tensor("float32", await pixels(frame, 80, true), [1, 3, 80, 80]);
      const result = await live.run({ [live.inputNames[0]!]: input });
      const probs = softmax(result[live.outputNames[0]!]!.data as Float32Array);
      scores.push(probs[1] ?? 0); // MiniFASNet class 1 = live
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { live: mean >= this.config.livenessThreshold, confidence: mean, reason: mean >= this.config.livenessThreshold ? null : "anti-spoof-threshold" };
  }
}
