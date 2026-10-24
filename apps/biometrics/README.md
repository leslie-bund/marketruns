# Private biometrics service

Node + ONNX Runtime service for ArcFace embeddings and MiniFASNet multi-frame liveness. It is called only by `apps/identity`; it has no mobile API, admin key, identification endpoint, or persistent capture store.

## Runtime

Required:

- `BIOMETRICS_INTERNAL_TOKEN` — at least 32 characters, shared only with identity.
- `FACE_MODEL_PATH` — ArcFace `w600k_r50.onnx`, 112×112 RGB, 512 outputs.
- `LIVENESS_MODEL_PATH` — MiniFASNet ONNX, 80×80 BGR, three-class output with class 1 = live.
- `LIVENESS_THRESHOLD` — optional engineering default `0.8`; benchmark before launch.
- `PORT` — default `8791`; `BIND_ADDRESS` — default `127.0.0.1`, set to `0.0.0.0` in the container.

Build with `pnpm build`; run with `pnpm start`. The Docker image is intended for an internal compose/Kubernetes network with **no published host port**. Deploy model artifacts as licensed, read-only runtime assets; they are not included here.

Endpoints: unauthenticated `GET /healthz`; bearer-protected `POST /v1/face/analyze` and `POST /v1/face/embed`. `analyze` requires 6–8 frames and invokes liveness before embedding. `embed` exists only for an authorized KYC callback-image fallback; public login/enrollment never uses it.

Tests inject deterministic fake model inference and require no native model artifacts. No accuracy benchmark is claimed.

## Provenance

Selectively adapted from the supplied `bug-free-giggle` snapshot: ArcFace preprocessing/L2 normalization from `recognition/embedder.ts`, MiniFASNet preprocessing/softmax structure from `liveness/antiSpoofing.ts`. No root LICENSE was found in that snapshot. Confirm permission before redistribution. Unrelated SDK/API, 1:N identification, and deepfake flows were not copied.
