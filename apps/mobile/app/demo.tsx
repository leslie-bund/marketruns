import { useEffect, useRef } from "react";
import { router } from "expo-router";
import { Text } from "react-native";
import {
  acceptProduct,
  attachPhoto,
  buyerOffer,
  checkout,
  finalDelivery,
  confirmHandoff,
  getHandoffChallenge,
  getRun,
  initiateHandoff,
  listIntentProducts,
  listIntents,
  newId,
  offerProduct,
  postIntent,
  scanChallenge,
} from "../src/api";
import { Card, Page, Pill } from "../src/ui";

/**
 * DEV-ONLY scripted walkthrough (ADR-0013 demo tooling). Open with a deep
 * link — exp://<metro-host>/demo — and the app itself drives the public API
 * through a full buyer → seller → buyer → checkout → runner flow, navigating
 * each real screen as the state changes. Every command below is the same
 * call a user tap would make; nothing bypasses the wire.
 */
export default function Demo() {
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    running.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Page eyebrow="DEV ONLY · SCRIPTED" title="Demo walkthrough">
      <Card>
        <Pill active>DRIVING THE REAL API</Pill>
        <Text>Watch the screens change as each command lands on the edge.</Text>
      </Card>
    </Page>
  );
}

async function run(): Promise<void> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // 1 — Buyer posts an intent.
  router.replace("/buyer");
  await wait(4000);
  await postIntent({
    shopItem: "Tomatoes",
    quantity: 2,
    unit: "kg",
    priceBand: { minKobo: 120_000, maxKobo: 180_000 },
    note: "Firm, ripe tomatoes please",
  });
  router.replace("/buyer");
  await wait(4000);

  // 2 — Seller responds with an ephemeral product.
  const intents = await listIntents();
  const intent = intents[intents.length - 1];
  router.replace("/seller");
  await wait(3500);
  await offerProduct({
    intentId: intent!.id,
    shopItem: intent!.shopItem,
    quantity: intent!.quantity,
    unit: intent!.unit,
    priceKobo: 165_000,
  });
  await wait(3000);

  // 3 — Buyer discovers it, negotiates, accepts.
  const products = await listIntentProducts(intent!.id);
  const product = products[0]!;
  router.replace("/buyer/products");
  await wait(4000);
  router.replace({ pathname: "/buyer/negotiation", params: { productId: product.id } });
  await wait(4000);
  await buyerOffer(product.id, 160_000);
  await wait(3000);
  await acceptProduct(product.id);
  await wait(2000);
  router.replace("/buyer/cart");
  await wait(4500);

  // 4 — Checkout at the floor rate.
  router.replace("/buyer/checkout");
  await wait(3500);
  const accepted = await checkout({ kind: "plus-code", plusCode: "6FR5+8X Lagos" }, undefined, { kind: "designated", name: "Receiver" });
  await wait(4500);

  // 5 — Runner: handoff, scan, evidence, delivery.
  router.replace("/runner");
  await wait(5000);
  const run = await getRun(accepted.runId);
  const nextStop = run?.stops.find((stop) => stop.status !== "completed");
  if (run && nextStop) {
    const handoffId = newId("handoff");
    await initiateHandoff(run.id, {
      handoffId, handoffType: "pickup",
      exchangePointId: nextStop.exchangePoint,
      counterparty: nextStop.sellerName,
    });
    await wait(1500);
    router.replace({ pathname: "/runner/handoff", params: { handoffId, runId: run.id } });
    const challenge = await getHandoffChallenge(run.id, handoffId);
    await scanChallenge(run.id, handoffId, challenge);
    await attachPhoto(run.id, handoffId, `r2://archive/captures/${handoffId}.jpg`);
    await wait(3000);
    const deliveryId = newId("handoff");
    const deliveryLabel = run.delivery.kind === "plus-code" ? run.delivery.plusCode : run.delivery.name;
    await initiateHandoff(run.id, { handoffId: deliveryId, handoffType: "delivery", exchangePointId: deliveryLabel, counterparty: "Receiver" });
    await scanChallenge(run.id, deliveryId, accepted.deliveryCode!);
    await attachPhoto(run.id, deliveryId, `r2://archive/captures/${deliveryId}.jpg`);
    await confirmHandoff(run.id, deliveryId);
    await finalDelivery(run.id);
    await wait(4000);
    router.replace("/runner");
  }
}
