import { describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.js";
import { bindings } from "./helpers.js";

const BASE = "http://edge";

describe("edge ops surface", () => {
  it.each(["/ops", "/ops/login"])("does not serve the retired embedded interface at %s", async (path) => {
    const response = await createApp().fetch(new Request(`${BASE}${path}`), bindings);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain("<!doctype html");
  });

  it("keeps the operator session API behind the existing authorization seam", async () => {
    const response = await createApp().fetch(new Request(`${BASE}/ops/api/session`), bindings);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operator: { role: "admin" } });
  });
});
