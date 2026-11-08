import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.config.js", import.meta.url), "utf8");
const appJson = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));

function loadConfig(env) {
  const module = { exports: {} };
  const evaluate = new Function("require", "process", "module", "exports", source);
  evaluate((id) => {
    assert.equal(id, "./app.json");
    return appJson;
  }, { env }, module, module.exports);
  return module.exports();
}

const stagingEnv = () => ({
  APP_ENV: "staging",
  EXPO_PUBLIC_EDGE_URL: "https://edge.staging.marketruns.ng",
  EXPO_PUBLIC_FLW_PUBLIC_KEY: "FLWPUBK_TEST-example-X",
  GOOGLE_MAPS_API_KEY: "maps-test-key",
});

test("local development does not require payment, edge, or maps build values", () => {
  assert.doesNotThrow(() => loadConfig({ APP_ENV: "development" }));
  assert.doesNotThrow(() => loadConfig({}));
});

test("staging accepts a test payment key and a non-local HTTPS edge", () => {
  const config = loadConfig(stagingEnv());
  assert.equal(config.android.config.googleMaps.apiKey, "maps-test-key");
  assert.equal(config.ios.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
  assert.equal(config.android.package, appJson.expo.android.package);
});

test("staging requires a Flutterwave test public key", () => {
  for (const value of [undefined, "", "FLWPUBK_LIVE-example-X", "FLWPUBK_TESTexample-X"]) {
    const env = stagingEnv();
    if (value === undefined) delete env.EXPO_PUBLIC_FLW_PUBLIC_KEY;
    else env.EXPO_PUBLIC_FLW_PUBLIC_KEY = value;
    assert.throws(() => loadConfig(env), /EXPO_PUBLIC_FLW_PUBLIC_KEY/);
  }
});

test("staging rejects missing, insecure, malformed, and local edge URLs", () => {
  for (const value of [
    undefined,
    "not-a-url",
    "http://edge.staging.marketruns.ng",
    "https://localhost:8787",
    "https://api.localhost",
    "https://runner.local",
    "https://127.0.0.1:8787",
    "https://[::1]:8787",
    "https://10.0.0.8",
    "https://172.20.0.8",
    "https://192.168.1.20",
  ]) {
    const env = stagingEnv();
    if (value === undefined) delete env.EXPO_PUBLIC_EDGE_URL;
    else env.EXPO_PUBLIC_EDGE_URL = value;
    assert.throws(() => loadConfig(env), /EXPO_PUBLIC_EDGE_URL/);
  }
});

test("staging still requires maps, while production keeps its existing key posture", () => {
  const missingMaps = stagingEnv();
  delete missingMaps.GOOGLE_MAPS_API_KEY;
  assert.throws(() => loadConfig(missingMaps), /GOOGLE_MAPS_API_KEY/);

  assert.doesNotThrow(() => loadConfig({
    APP_ENV: "production",
    EXPO_PUBLIC_EDGE_URL: "https://edge.marketruns.ng",
    GOOGLE_MAPS_API_KEY: "maps-production-key",
  }));
});

test("EAS build profile selects staging validation", () => {
  const env = stagingEnv();
  delete env.APP_ENV;
  env.EAS_BUILD_PROFILE = "staging";
  assert.doesNotThrow(() => loadConfig(env));
});
