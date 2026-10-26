import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createBiometricHandler, type BiometricModel } from "../src/service.js";

const token = "test-private-token-at-least-32-characters";
const image = Buffer.alloc(64, 7).toString("base64");
const frames = Array.from({ length: 7 }, (_, i) => Buffer.alloc(64, i + 1).toString("base64"));
class FakeModel implements BiometricModel {
  readonly modelVersion = "fake-onnx-v1";
  embedCalls = 0; livenessCalls = 0; embeddedImage: Buffer | null = null;
  constructor(private live = true, private invalidEmbedding = false) {}
  async embed(image: Buffer) {
    this.embedCalls++; this.embeddedImage = image;
    const values = Float32Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
    if (this.invalidEmbedding) values[4] = Number.NaN;
    return values;
  }
  async liveness() { this.livenessCalls++; return { live: this.live, confidence: 0.99, reason: this.live ? null : "fake-spoof" }; }
}
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });
async function setup(model: BiometricModel, endpoint: "analyze" | "embed" = "analyze") {
  const server = createServer(createBiometricHandler(model, token)); servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
  return async (body: unknown, auth = token) => fetch(`http://127.0.0.1:${address.port}/v1/face/${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
describe("private biometric service", () => {
  it("requires the private token and runs liveness before deterministic embedding", async () => {
    const model = new FakeModel(); const call = await setup(model);
    expect((await call({ image, frames }, "wrong")).status).toBe(401);
    const res = await call({ image, frames }); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.embedding).toHaveLength(512); expect(body.modelVersion).toBe("fake-onnx-v1");
    expect(model.embedCalls).toBe(1); expect(model.livenessCalls).toBe(1);
  });
  it("fails closed on spoof, repeated frames, and invalid job shapes", async () => {
    const model = new FakeModel(false); const call = await setup(model);
    expect((await call({ image, frames })).status).toBe(422); expect(model.embedCalls).toBe(0);
    expect((await call({ image, frames: Array(7).fill(frames[0]) })).status).toBe(422);
    expect((await call({ image, frames: frames.slice(0, 5) })).status).toBe(400);
  });
  it("embed-only enrollment strips EXIF, embeds the returned bytes, and skips local liveness", async () => {
    const original = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } })
      .jpeg().withExif({ IFD0: { Copyright: "remove-me" } }).toBuffer();
    const model = new FakeModel(); const call = await setup(model, "embed");
    const res = await call({ image: original.toString("base64") }); expect(res.status).toBe(200);
    const body = await res.json(); const normalized = Buffer.from(body.image, "base64");
    expect((await sharp(normalized).metadata()).exif).toBeUndefined();
    expect(model.embeddedImage).toEqual(normalized); expect(model.livenessCalls).toBe(0);
  });
  it("rejects non-finite embedding output on the enrollment-only endpoint", async () => {
    const model = new FakeModel(true, true); const call = await setup(model, "embed");
    const original = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
    const res = await call({ image: original.toString("base64") }); expect(res.status).toBe(502);
    expect(model.livenessCalls).toBe(0);
  });
});
