import { describe, expect, it } from "vitest";
import { validateNotificationsTopology } from "../src/topology.js";

describe("notification service topology", () => {
  const NOTIFICATION_INTERNAL_TOKEN = "notification-topology-test-token";

  it("keeps loopback development and rejects missing or loopback deployed URLs", () => {
    expect(() => validateNotificationsTopology({})).not.toThrow();
    expect(() => validateNotificationsTopology({ NOTIFICATIONS_ENV: "staging", NOTIFICATION_INTERNAL_TOKEN })).toThrow(/EDGE_URL is required/);
    expect(() => validateNotificationsTopology({ NOTIFICATIONS_ENV: "production", EDGE_URL: "http://localhost:8787", NOTIFICATION_INTERNAL_TOKEN })).toThrow(/non-local HTTPS/);
  });

  it("requires the shared internal token in deployed posture", () => {
    expect(() => validateNotificationsTopology({
      NOTIFICATIONS_ENV: "staging",
      EDGE_URL: "https://edge-staging.example.com",
    })).toThrow(/NOTIFICATION_INTERNAL_TOKEN is required/);
  });

  it("accepts an explicit deployed edge URL", () => {
    expect(() => validateNotificationsTopology({
      NOTIFICATIONS_ENV: "staging",
      EDGE_URL: "https://edge-staging.example.com",
      NOTIFICATION_INTERNAL_TOKEN,
    })).not.toThrow();
  });
});
