import { describe, expect, it } from "vitest";
import { validateNotificationsTopology } from "../src/topology.js";

describe("notification service topology", () => {
  it("keeps loopback development and rejects missing or loopback deployed URLs", () => {
    expect(() => validateNotificationsTopology({})).not.toThrow();
    expect(() => validateNotificationsTopology({ NOTIFICATIONS_ENV: "staging" })).toThrow(/EDGE_URL is required/);
    expect(() => validateNotificationsTopology({ NOTIFICATIONS_ENV: "production", EDGE_URL: "http://localhost:8787" })).toThrow(/non-local HTTPS/);
  });

  it("accepts an explicit deployed edge URL", () => {
    expect(() => validateNotificationsTopology({ NOTIFICATIONS_ENV: "staging", EDGE_URL: "https://edge-staging.example.com" })).not.toThrow();
  });
});
