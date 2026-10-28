import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.__DEV__ = true;
process.env.EXPO_PUBLIC_DEMO_MODE = "true";
const { assertDemoWriteAllowed, devDemoModeEnabled, withDevRehearsal } = await import("../src/api/dev-mode.ts");

test("Explore reads work but anonymous transactional writes fail before fetch", () => {
  assert.doesNotThrow(() => assertDemoWriteAllowed("GET", false));
  assert.doesNotThrow(() => assertDemoWriteAllowed(undefined, false));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.throws(() => assertDemoWriteAllowed(method, false), /read-only/);
    assert.doesNotThrow(() => assertDemoWriteAllowed(method, true));
  }
});

test("only __DEV__ plus the explicit demo flag enables rehearsal shortcuts", async () => {
  assert.equal(devDemoModeEnabled(false, "true"), false);
  assert.equal(devDemoModeEnabled(true, undefined), false);
  assert.equal(devDemoModeEnabled(true, "false"), false);
  assert.equal(devDemoModeEnabled(true, "true"), true);
  await withDevRehearsal(async () => {
    assert.doesNotThrow(() => assertDemoWriteAllowed("POST", false));
  });
  assert.throws(() => assertDemoWriteAllowed("POST", false), /read-only/);
});

test("iOS location is foreground-only and media capture stays camera-only", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const location = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-location");
  assert.match(location[1].locationWhenInUseUsageDescription, /foreground location/);
  assert.equal(location[1].isIosBackgroundLocationEnabled, false);
  assert.equal(location[1].isAndroidBackgroundLocationEnabled, false);
  assert.equal(config.expo.plugins.some((plugin) => String(plugin).includes("media-library")), false);
});
