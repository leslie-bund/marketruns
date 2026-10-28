import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const runner = source("app/runner/handoff.tsx");
const buyerRun = source("app/buyer/run.tsx");
const products = source("app/buyer/products.tsx");
const respond = source("app/seller/respond.tsx");
const notifications = source("app/notifications.tsx");
const negotiations = source("app/seller/negotiations.tsx");
const badges = source("src/features/seller/hooks.ts");
const opsHtml = source("../edge/src/ops-console/html.ts");

test("failed or wrong pickup scans expose a real retry and receiver copy names the runner", () => {
  assert.match(runner, /setScanProblem\("This is not the server-issued QR/);
  assert.match(runner, /title="Retry scan" onPress={retryScan}/);
  assert.match(runner, /onBarcodeScanned={onScan}/);
  assert.match(buyerRun, /Give this code to the runner only when they deliver your items/);
  assert.match(buyerRun, /your designated receiver/);
});

test("delivery codes expose loading, error, expiry, retry, and authenticated rotation", () => {
  assert.match(buyerRun, /Loading secure delivery code/);
  assert.match(buyerRun, /Could not load the delivery code/);
  assert.match(buyerRun, /This delivery code has expired/);
  assert.match(buyerRun, /Retry loading delivery code/);
  assert.match(buyerRun, /Issue new delivery code/);
  assert.match(buyerRun, /rotateDeliveryCode\(currentId\)/);
  assert.match(buyerRun, /Expires \{new Date\(visibleCode.expiresAt\)/);
});

test("product and ops evidence never rely on unauthenticated image links", () => {
  assert.match(products, /productCaptureUrl\(product.id\)/);
  assert.match(products, /headers: \{ \.\.\.sessionHeaders\(\), \.\.\.participantHeaders\(\) \}/);
  assert.match(respond, /captureUrl\(photo.ref\), headers:/);
  assert.match(opsHtml, /href="\/ops\/api\/captures\//);
  assert.doesNotMatch(opsHtml, /href="\/captures\//);
});

test("notification centre distinguishes first load, pages results, and reports read errors", () => {
  assert.match(notifications, /useState<NotificationListResponse \| null>\(null\)/);
  assert.match(notifications, /Loading notifications…/);
  assert.match(notifications, /PAGE_SIZE/);
  assert.match(notifications, /title="Previous"/);
  assert.match(notifications, /title="Next"/);
  assert.match(notifications, /Mark loaded as read/);
  assert.match(notifications, /Could not mark the notification as read/);
  assert.doesNotMatch(notifications, /Mark all as read/);
});

test("accepted products navigate and seller badges clear after a scan", () => {
  assert.match(negotiations, /title="View trip" secondary onPress/);
  assert.match(badges, /handoff.status === "pending" && handoff.scannedAt == null/);
});
