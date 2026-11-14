import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import { bindings } from "./helpers.js";

describe("public market catalogue", () => {
  it("returns only the fields the mobile market picker needs without credentials", async () => {
    const response = await createApp().fetch(new Request("http://edge/markets/catalog"), bindings);

    expect(response.status).toBe(200);
    const body = await response.json() as { markets: Array<Record<string, unknown>> };
    expect(body.markets.length).toBeGreaterThan(0);
    expect(body.markets[0]).toMatchObject({
      id: "Balogun",
      name: "Balogun",
      opensAt: "08:00",
      closesAt: "18:00",
      onlineSellers: 0,
    });
    expect(body.markets[0]).not.toHaveProperty("geofence");
  });
});
