import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("iOS location is foreground-only and media capture stays camera-only", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const location = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-location");
  assert.match(location[1].locationWhenInUseUsageDescription, /foreground location/);
  assert.equal(location[1].isIosBackgroundLocationEnabled, false);
  assert.equal(location[1].isAndroidBackgroundLocationEnabled, false);
  assert.equal(config.expo.plugins.some((plugin) => String(plugin).includes("media-library")), false);
});
