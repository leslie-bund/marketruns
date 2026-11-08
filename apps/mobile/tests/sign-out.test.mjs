import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launch = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("account sign-out uses local auth teardown and returns to role selection", () => {
  assert.match(launch, /<Section title="Account">/);
  assert.match(launch, /title=\{signingOut \? "Signing out…" : "Sign out"\}/);
  assert.match(launch, /await signOut\(\);[\s\S]*?router\.replace\("\/"\);/);
  assert.match(launch, /catch \(error\)[\s\S]*?Alert\.alert\("Sign out failed"/);
  const handler = launch.match(/const signOutAccount = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(handler, "normal sign-out has its own account handler");
  assert.doesNotMatch(handler[1], /setActiveParticipant|clearCartState|resetIdentity/);
});
