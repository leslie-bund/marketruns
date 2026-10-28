import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { validateIdentityRuntime } from "../src/runtime-config.js";

const production = {
  IDENTITY_ENV: "production",
  FACE_VERIFIER: "hybrid",
  IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  IDENTITY_SESSION_SECRET: "s".repeat(32),
  IDENTITY_INTERNAL_TOKEN: "i".repeat(32),
  DATABASE_URL: "postgres://identity.example.com/market_runs",
  BIOMETRICS_SERVICE_URL: "https://biometrics.internal.example.com",
  BIOMETRICS_SERVICE_TOKEN: "b".repeat(32),
  SMILEID_PARTNER_ID: "partner",
  SMILEID_API_KEY: "vendor-key",
  IDENTITY_CAPTURES: {} as R2Bucket,
} satisfies Env;

describe("production identity runtime configuration", () => {
  it("fails closed on every missing hybrid requirement", () => {
    expect(() => validateIdentityRuntime({ IDENTITY_ENV: "production" })).toThrow(/required in production/);
    expect(() => validateIdentityRuntime({ ...production, FACE_VERIFIER: "stub" })).toThrow(/FACE_VERIFIER=hybrid/);
    for (const name of ["IDENTITY_CAPTURES", "BIOMETRICS_SERVICE_TOKEN", "SMILEID_API_KEY"] as const) {
      const env = { ...production, [name]: undefined };
      expect(() => validateIdentityRuntime(env)).toThrow(new RegExp(name));
    }
  });

  it("rejects loopback biometrics and leaves the local stub posture unchanged", () => {
    expect(() => validateIdentityRuntime({ ...production, BIOMETRICS_SERVICE_URL: "http://localhost:8792" })).toThrow(/non-local HTTPS/);
    expect(() => validateIdentityRuntime({})).not.toThrow();
    expect(() => validateIdentityRuntime(production)).not.toThrow();
  });
});
