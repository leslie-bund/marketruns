import { describe, expect, it } from "vitest";
import { plusCodeToLocation } from "../src/plus-code.js";

describe("plusCodeToLocation", () => {
  it("decodes a full code (Google HQ)", () => {
    const location = plusCodeToLocation("849VCWC8+R9");
    expect(location).not.toBeNull();
    expect(location!.latitude).toBeCloseTo(37.422, 3);
    expect(location!.longitude).toBeCloseTo(-122.084, 3);
  });

  it("recovers a short code near its reference", () => {
    const reference = { latitude: 37.4225, longitude: -122.0845 };
    const location = plusCodeToLocation("CWC8+R9", reference);
    expect(location).not.toBeNull();
    expect(Math.abs(location!.latitude - reference.latitude)).toBeLessThan(0.01);
    expect(Math.abs(location!.longitude - reference.longitude)).toBeLessThan(0.01);
  });

  it("recovers a short code with a locality suffix (Balogun market)", () => {
    // "F93V+JV Lagos" is the short form of 6FR5F93V+JV — Balogun Market.
    const reference = { latitude: 6.4541, longitude: 3.3947 };
    const location = plusCodeToLocation("F93V+JV Lagos", reference);
    expect(location).not.toBeNull();
    expect(Math.abs(location!.latitude - reference.latitude)).toBeLessThan(0.001);
    expect(Math.abs(location!.longitude - reference.longitude)).toBeLessThan(0.001);
  });

  it("returns null for garbage and for short codes without a reference", () => {
    expect(plusCodeToLocation("not a code")).toBeNull();
    expect(plusCodeToLocation("")).toBeNull();
    expect(plusCodeToLocation("CWC8+R9")).toBeNull();
  });
});
