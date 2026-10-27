import { test, expect } from "@playwright/test";

const evidence = "test-results/ux";

test("launch, role navigation, and deployed ops login are inspectable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", (request) => console.log("REQUEST_FAILED", request.url(), request.failure()));

  const bundle = await page.request.get("/apps/mobile/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable");
  if (bundle.status() !== 200) throw new Error(`Expo bundle ${bundle.status()}: ${await bundle.text()}`);
  await expect.poll(async () => {
    try { return (await page.request.get("http://127.0.0.1:8787/healthz")).status(); }
    catch { return 0; }
  }, { timeout: 120_000 }).toBe(200);
  const marketsApi = await page.request.get("http://127.0.0.1:8787/markets", { headers: { Origin: "http://127.0.0.1:8081" } });
  console.log("MARKETS_API", marketsApi.status(), await marketsApi.text(), JSON.stringify(marketsApi.headers()));
  await page.goto("/");
  await expect(page.getByText("Explore as (demo)")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${evidence}/launch.png`, fullPage: true });

  await page.getByText("Buyer", { exact: true }).click();
  await expect(page.getByText("Choose a market for buyer")).toBeVisible();
  await page.screenshot({ path: `${evidence}/markets.png`, fullPage: true });

  const ops = await page.request.get("http://127.0.0.1:8787/ops/login");
  console.log("OPS_LOGIN_STATUS", ops.status(), await ops.text());
  console.log("BROWSER_ERRORS", JSON.stringify(errors));
  expect(errors).toEqual([]);
});
