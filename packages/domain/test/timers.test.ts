import { describe, expect, it } from "vitest";
import {
  CART_MAX_DURATION_MS,
  cartDeadline,
  INTENT_TTL_MS,
  marketCloseGateOk,
  productTtl,
} from "../src/index.js";

describe("timer rules", () => {
  it("sets the Cart lap timer from first acceptance and extends it by ten minutes", () => {
    const first = 1_000;
    expect(cartDeadline(first, 1)).toBe(first + 30 * 60_000);
    expect(cartDeadline(first, 2)).toBe(first + 40 * 60_000);
    expect(cartDeadline(first, 4)).toBe(first + CART_MAX_DURATION_MS);
  });

  it("expires Product with its Intent, at most thirty minutes from creation", () => {
    expect(productTtl(0, 10 * 60_000)).toBe(10 * 60_000);
    expect(productTtl(0, 45 * 60_000)).toBe(INTENT_TTL_MS);
  });

  it("requires strictly more than estimated trip duration plus buffer before Market close", () => {
    expect(marketCloseGateOk(0, 31, 20, 10)).toBe(true);
    expect(marketCloseGateOk(0, 30, 20, 10)).toBe(false);
  });
});
