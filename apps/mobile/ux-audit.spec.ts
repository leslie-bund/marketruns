import { test, expect } from "@playwright/test";

const evidence = "test-results/ux";

test("overview, role homes, and representative forms fit mobile without browser errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() === 404) errors.push(`404 ${response.url()}`); });
  page.on("requestfailed", (request) => errors.push(`REQUEST_FAILED ${request.url()} ${request.failure()?.errorText ?? ""}`));

  const bundle = await page.request.get("/apps/mobile/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable");
  if (bundle.status() !== 200) throw new Error(`Expo bundle ${bundle.status()}: ${await bundle.text()}`);
  await expect.poll(async () => {
    try { return (await page.request.get("http://127.0.0.1:8787/healthz")).status(); }
    catch { return 0; }
  }, { timeout: 120_000 }).toBe(200);

  const inspect = async (path: string, name: string, heading: string) => {
    await page.goto(path);
    await expect(page.getByText(heading, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  };

  await inspect("/", "launch", "Explore as (demo)");
  await page.getByText("Buyer", { exact: true }).click();
  await expect(page.getByText("Choose a market for buyer")).toBeVisible();
  await page.screenshot({ path: `${evidence}/markets.png`, fullPage: true });

  await inspect("/buyer", "buyer", "Your errands");
  await inspect("/seller", "seller", "Join your market");
  await inspect("/seller/join", "seller-join", "Create your Store");
  await inspect("/runner", "runner", "Available to claim");
  await inspect("/buyer/post", "post-intent", "What do you need?");
  await inspect("/buyer/checkout", "checkout", "Delivery");
  await inspect("/onboarding", "onboarding", "Who are you?");

  console.log("BROWSER_ERRORS", JSON.stringify(errors));
  expect(errors).toEqual([]);
});
