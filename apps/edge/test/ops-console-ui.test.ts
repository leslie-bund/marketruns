import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import { bindings } from "./helpers.js";

const BASE = "http://edge";

async function opsPage(path: string): Promise<string> {
  const response = await createApp().fetch(new Request(`${BASE}${path}`), bindings);
  expect(response.status).toBe(200);
  return response.text();
}

describe("ops console presentation", () => {
  it("keeps sign-in operational without the production-pilot tagline", async () => {
    const html = await opsPage("/ops/login");

    expect(html).toContain("<h1>Ops sign in</h1>");
    expect(html).toContain("Operator access only. Participant authentication is separate.");
    expect(html).toContain("Bootstrap password must be changed before console access.");
    expect(html).not.toContain("PRODUCTION PILOT");
  });

  it("removes marketing and redundant helper copy from the overview and summaries", async () => {
    const html = await opsPage("/ops");

    expect(html).toContain("<h1>Ops console</h1>");
    expect(html).toContain("Loading gate metrics…");
    expect(html).toContain('<span class="summary-title">Administration</span>');
    expect(html).toContain('<span class="summary-title">Dev demo driver</span>');
    expect(html).toContain('<span class="eyebrow">Markets</span>');
    expect(html).toContain("Stores without items stay registered but stop matching intents.");
    expect(html).toContain("Loading heartbeats…");
    expect(html).not.toContain("Production pilot");
    expect(html).not.toContain("Live instances & management");
    expect(html).not.toContain("Deterministic demo ids per step");
    expect(html).not.toContain("Expansion gate — ADR-0013");
    expect(html).not.toContain("Every kobo flows through the settlement function");
    expect(html).not.toContain("Open to load explicit instance heartbeats");
    expect(html).not.toContain("Participant involvements — read only");
    expect(html).not.toContain("The vocabulary grows as sellers register stores");
    expect(html).not.toContain("Requests appear when a participant reports a lost device");
    expect(html).not.toContain("Nothing here yet");
    expect(html).toContain('emptyState("No pending resets", "")');
  });

  it("preserves money, evidence, security, and service-degradation caveats", async () => {
    const html = await opsPage("/ops");

    expect(html).toContain("(not buyer surcharges)");
    expect(html).toContain("Settlement legs are computed by the settlement function — no side channels.");
    expect(html).toContain("Aborts never refund fully; runner and platform settle partially.");
    expect(html).toContain("Geofence changes apply immediately to presence, claims, and pickups.");
    expect(html).toContain("Scan QR challenge");
    expect(html).toContain("Runner location");
    expect(html).toContain("waiting for runner photo evidence");
    expect(html).toContain("buyer silence = consent");
    expect(html).toContain("Dispute — review before settle");
    expect(html).toContain("does not create a new transfer");
    expect(html).toContain("Approving revokes every device credential and live session");
    expect(html).toContain("Decisions are final.");
    expect(html).toContain("Archive unavailable");
    expect(html).toContain("Payments unavailable");
    expect(html).toContain("Identity unavailable");
  });
});
