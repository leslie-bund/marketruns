import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_REFERENCE_LENGTH,
  PROVIDER_REFERENCE_HASH_HEX_LENGTH,
  PROVIDER_REFERENCE_PREFIX,
  providerReferenceFor,
} from "../src/provider-reference.js";

describe("provider reference alias", () => {
  const key = "settlement:run:cart:Balogun:buyer:e2e-s3-123456789:settlement:leg:0";

  it("is short enough for the provider cap in live and test mode", async () => {
    const alias = await providerReferenceFor(key);
    expect(alias.length).toBeLessThanOrEqual(MAX_PROVIDER_REFERENCE_LENGTH);
    // The Flutterwave test-mode accelerator suffix is 9 characters.
    expect(alias.length + "_PMCKDU_1".length).toBeLessThanOrEqual(MAX_PROVIDER_REFERENCE_LENGTH);
    expect(alias.startsWith(PROVIDER_REFERENCE_PREFIX)).toBe(true);
    expect(alias).toMatch(new RegExp(`^${PROVIDER_REFERENCE_PREFIX}[0-9a-f]{${PROVIDER_REFERENCE_HASH_HEX_LENGTH}}$`));
  });

  it("is deterministic across calls", async () => {
    expect(await providerReferenceFor(key)).toBe(await providerReferenceFor(key));
  });

  it("separates legs and runs", async () => {
    const leg0 = await providerReferenceFor(key);
    const leg1 = await providerReferenceFor(key.replace(/:leg:0$/, ":leg:1"));
    const otherRun = await providerReferenceFor(key.replace("e2e-s3-123456789", "e2e-s3-987654321"));
    expect(new Set([leg0, leg1, otherRun]).size).toBe(3);
  });

  it("rejects an empty key rather than aliasing the empty string", async () => {
    await expect(providerReferenceFor("")).rejects.toThrow(/must not be empty/);
  });
});
