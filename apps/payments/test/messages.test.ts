import { describe, expect, it } from "vitest";
import { parsePaymentMessage } from "../src/messages.js";
import { sampleDispatchRequest } from "./helpers.js";

describe("payment message parsing", () => {
  it("accepts payment.dispatch-requested, string-serialized or parsed", () => {
    const body = sampleDispatchRequest();
    expect(parsePaymentMessage(body).success).toBe(true);
    expect(parsePaymentMessage(JSON.stringify(body)).success).toBe(true);
  });

  it("rejects unknown types, empty legs, and malformed payloads", () => {
    expect(parsePaymentMessage({ type: "payment.dispatch-requested" }).success).toBe(false);
    expect(parsePaymentMessage({ type: "settlement.released" }).success).toBe(false);
    expect(parsePaymentMessage(sampleDispatchRequest({ legs: [] })).success).toBe(false);
    expect(parsePaymentMessage("not json").success).toBe(false);
  });

  it("rejects negative amounts and missing idempotency keys", () => {
    const bad = sampleDispatchRequest();
    bad.legs[0]!.amountKobo = -1;
    expect(parsePaymentMessage(bad).success).toBe(false);
    expect(parsePaymentMessage({ ...sampleDispatchRequest(), idempotencyKey: "" }).success).toBe(false);
  });
});
