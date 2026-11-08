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
  EDGE_URL: "https://edge.marketruns.test",
  BIOMETRICS_SERVICE_URL: "https://biometrics.internal.example.com",
  BIOMETRICS_SERVICE_TOKEN: "b".repeat(32),
  SMILEID_PARTNER_ID: "partner",
  SMILEID_API_KEY: "vendor-key",
  SMILEID_ENV: "production",
  SMILEID_CALLBACK_URL: "https://edge.marketruns.test/callbacks/smileid",
  SMILEID_PRIVACY_NOTICE_URL: "https://www.marketruns.test/privacy",
  IDENTITY_CAPTURES: {} as R2Bucket,
} satisfies Env;
const staging = { ...production, IDENTITY_ENV: "staging", SMILEID_ENV: "sandbox" } satisfies Env;
const localHybrid = {
  FACE_VERIFIER: "hybrid",
  IDENTITY_INTERNAL_TOKEN: "i".repeat(32),
  EDGE_URL: "http://127.0.0.1:8787",
  BIOMETRICS_SERVICE_URL: "http://127.0.0.1:8792",
  BIOMETRICS_SERVICE_TOKEN: "b".repeat(32),
  SMILEID_PARTNER_ID: "partner",
  SMILEID_API_KEY: "vendor-key",
  SMILEID_ENV: "sandbox",
  SMILEID_PRIVACY_NOTICE_URL: "https://www.marketruns.test/privacy",
  IDENTITY_CAPTURES: {} as R2Bucket,
} satisfies Env;

describe("deployed identity runtime configuration", () => {
  it("fails closed on every missing hybrid requirement", () => {
    expect(() => validateIdentityRuntime({ IDENTITY_ENV: "production" })).toThrow(/required in deployed identity/);
    expect(() => validateIdentityRuntime({ ...production, FACE_VERIFIER: "stub" })).toThrow(/FACE_VERIFIER=hybrid/);
    for (const name of ["IDENTITY_CAPTURES", "BIOMETRICS_SERVICE_TOKEN", "SMILEID_API_KEY", "EDGE_URL"] as const) {
      const env = { ...production, [name]: undefined };
      expect(() => validateIdentityRuntime(env)).toThrow(new RegExp(name));
    }
  });

  it("rejects loopback biometrics and leaves the local stub posture unchanged", () => {
    expect(() => validateIdentityRuntime({ ...production, BIOMETRICS_SERVICE_URL: "http://localhost:8792" })).toThrow(/non-local HTTPS/);
    expect(() => validateIdentityRuntime({})).not.toThrow();
    expect(() => validateIdentityRuntime({ FACE_VERIFIER: "stub" })).not.toThrow();
    expect(() => validateIdentityRuntime(production)).not.toThrow();
  });

  it("requires real staging secrets, sandbox KYC, and the edge callback relationship", () => {
    expect(() => validateIdentityRuntime({ IDENTITY_ENV: "staging" })).toThrow(/required in deployed identity/);
    expect(() => validateIdentityRuntime({ ...staging, SMILEID_ENV: "production" })).toThrow(/SMILEID_ENV=sandbox/);
    expect(() => validateIdentityRuntime({ ...staging, SMILEID_CALLBACK_URL: "https://attacker.test/callbacks/smileid" })).toThrow(/EDGE_URL\/callbacks\/smileid/);
    expect(() => validateIdentityRuntime({ ...staging, SMILEID_PRIVACY_NOTICE_URL: "https://example.com/privacy" })).toThrow(/not an example URL/);
    expect(() => validateIdentityRuntime(staging)).not.toThrow();
  });
});

describe("local hybrid identity runtime configuration", () => {
  it("requires every real-service dependency without affecting empty local test envs", () => {
    for (const name of [
      "IDENTITY_INTERNAL_TOKEN",
      "EDGE_URL",
      "BIOMETRICS_SERVICE_URL",
      "BIOMETRICS_SERVICE_TOKEN",
      "SMILEID_PARTNER_ID",
      "SMILEID_API_KEY",
      "SMILEID_PRIVACY_NOTICE_URL",
      "IDENTITY_CAPTURES",
    ] as const) {
      expect(() => validateIdentityRuntime({ ...localHybrid, [name]: undefined })).toThrow(new RegExp(name));
    }
    expect(() => validateIdentityRuntime({ ...localHybrid, SMILEID_ENV: "production" })).toThrow(/SMILEID_ENV=sandbox/);
    expect(() => validateIdentityRuntime({})).not.toThrow();
  });

  it("allows loopback HTTP locally but rejects plain HTTP to remote biometrics", () => {
    expect(() => validateIdentityRuntime(localHybrid)).not.toThrow();
    expect(() => validateIdentityRuntime({ ...localHybrid, BIOMETRICS_SERVICE_URL: "http://localhost:8792" })).not.toThrow();
    expect(() => validateIdentityRuntime({ ...localHybrid, BIOMETRICS_SERVICE_URL: "http://192.168.1.20:8792" })).toThrow(/loopback HTTP/);
  });

  it("requires a non-example privacy URL and supports the existing smileid selector", () => {
    expect(() => validateIdentityRuntime({ ...localHybrid, SMILEID_PRIVACY_NOTICE_URL: "https://example.com/privacy" })).toThrow(/not an example URL/);
    expect(() => validateIdentityRuntime({ ...localHybrid, FACE_VERIFIER: "smileid" })).not.toThrow();
  });
});
