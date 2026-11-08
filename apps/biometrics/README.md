# Private biometrics service

Node + ONNX Runtime service for ArcFace embeddings and MiniFASNet multi-frame liveness. It is called only by `apps/identity`; it has no mobile API, admin key, identification endpoint, or persistent capture store.

## Runtime

Required for direct Node execution:

- `BIOMETRICS_INTERNAL_TOKEN` — at least 32 characters, shared only with identity.
- `FACE_MODEL_PATH` — ArcFace `w600k_r50.onnx`, 112×112 RGB, 512 outputs.
- `LIVENESS_MODEL_PATH` — MiniFASNet ONNX, 80×80 BGR, three-class output with class 1 = live. Required for `/analyze` and routine local login/recovery, but not for enrollment-only `/embed`.
- `LIVENESS_THRESHOLD` — optional engineering default `0.8`; benchmark before launch.
- `PORT` — default `8791`; `BIND_ADDRESS` — default `127.0.0.1`, set to `0.0.0.0` in the container.

Build with `pnpm build`; run with `pnpm start`.

### Local Docker lifecycle

The Docker build context contains the existing model artifacts under `models/`:

- `w600k_r50.onnx`
- `MiniFASNetV2.onnx`

`Dockerfile` copies both into `/models` in the image, so local Compose and Render use the same self-contained runtime with no host mount or persistent disk. Model binaries are not committed to GitHub; build and push the image from `apps/biometrics` using the private container-registry workflow. Set identity's `BIOMETRICS_SERVICE_TOKEN` to the same random 32+-character value that the service requires. Compose maps that variable to the container's `BIOMETRICS_INTERNAL_TOKEN` and sets `BIND_ADDRESS=0.0.0.0` inside the container. The only published local endpoint is `127.0.0.1:8792:8791`; port 8791 on the host remains the notifications worker, and biometrics is never published on a LAN interface.

`infra/dev-servers.sh` (and therefore `infra/dev-all.sh`) builds and starts this service before identity whenever `FACE_VERIFIER=hybrid` (the legacy-supported `smileid` selector follows the same local path). It fails before identity startup if either image model or token is missing, then waits for `GET /healthz`. It never falls back to the identity stub. A healthy pre-existing loopback service is reused and left running; a container started by the script has its container id recorded in `.dev-logs/biometrics.started` and is stopped by `infra/dev-servers.sh --stop` or the owning `dev-all` cleanup. Other containers are not stopped.

Endpoints: unauthenticated `GET /healthz`; bearer-protected `POST /v1/face/analyze` and `POST /v1/face/embed`. `analyze` requires 6–8 frames and invokes local liveness before embedding for routine login/recovery. Hybrid enrollment calls only `embed`: the service strips EXIF/re-encodes the submitted device selfie, computes a finite embedding from those exact normalized bytes, and returns them to identity for hash-bound vendor submission and private retention. Provider callback images are never accepted here.

Tests are explicit isolated fixtures: they inject deterministic fake model inference and require no native model artifacts or real identity vendor. `test:stack` forces `FACE_VERIFIER=stub`, so it neither starts this service nor loads real identity credentials. No accuracy benchmark is claimed.

## Provenance

Selectively adapted from the supplied `bug-free-giggle` snapshot: ArcFace preprocessing/L2 normalization from `recognition/embedder.ts`, MiniFASNet preprocessing/softmax structure from `liveness/antiSpoofing.ts`. No root LICENSE was found in that snapshot. Confirm permission before redistribution. Unrelated SDK/API, 1:N identification, and deepfake flows were not copied.
