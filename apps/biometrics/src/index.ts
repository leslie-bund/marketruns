import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { OnnxBiometricModel } from "./onnx.js";
import { createBiometricHandler } from "./service.js";

const token = process.env.BIOMETRICS_INTERNAL_TOKEN ?? "";
const faceModelPath = process.env.FACE_MODEL_PATH ?? "";
const livenessModelPath = process.env.LIVENESS_MODEL_PATH ?? "";
if (!existsSync(faceModelPath) || (livenessModelPath && !existsSync(livenessModelPath))) {
  throw new Error("FACE_MODEL_PATH and any configured LIVENESS_MODEL_PATH must point to readable ONNX artifacts; no fallback model is provided");
}
const threshold = Number(process.env.LIVENESS_THRESHOLD ?? "0.8");
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("LIVENESS_THRESHOLD must be in [0,1]");
const model = new OnnxBiometricModel({ faceModelPath, livenessModelPath, livenessThreshold: threshold });
const server = createServer(createBiometricHandler(model, token));
server.listen(Number(process.env.PORT ?? "8791"), process.env.BIND_ADDRESS ?? "127.0.0.1");
