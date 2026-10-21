#!/usr/bin/env node
/**
 * seed-demo.mjs — seed demo stores over the PUBLIC client wire.
 *
 * Every call is the exact `store.registered` command the seller app sends
 * (POST /command, packages/proto/src/store.ts), with a seller participant
 * header (the edge's dev auth seam, ADR-0015). Store registration is keyed
 * by `storeId` in MarketDO.registerStore, and this script uses deterministic
 * ids — re-running is a no-op replay, never a duplicate.
 *
 * No dependencies: Node 18+ built-in fetch.
 *
 * Usage:
 *   node infra/seed-demo.mjs [--edge http://localhost:8787]
 *   EDGE_URL=http://localhost:8787 node infra/seed-demo.mjs
 */

const args = process.argv.slice(2);
let edge = process.env.EDGE_URL ?? "http://localhost:8787";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--edge" && args[i + 1]) edge = args[i + 1];
  if (args[i] === "--help" || args[i] === "-h") {
    console.log("usage: node infra/seed-demo.mjs [--edge http://localhost:8787]");
    process.exit(0);
  }
}
edge = edge.replace(/\/$/, "");

/**
 * Demo catalog. The market vocabulary grows from what stores register
 * (ADR-0006), so these shop items are what buyers can post intents for.
 * Item names stay display-simple — the buyer app lists them verbatim.
 */
const STORES = [
  {
    storeId: "store:demo-aminas-fresh",
    market: "Balogun",
    name: "Amina's Fresh Store",
    exchangePoint: "Balogun Market, Stall B14",
    shopItems: ["Tomatoes (basket)", "Scotch Bonnet Peppers", "Red Onions", "Yam Tubers"],
    sellerId: "participant:demo-amina",
  },
  {
    storeId: "store:demo-mama-ngozi",
    market: "Balogun",
    name: "Mama Ngozi Provisions",
    exchangePoint: "Balogun Market, Line C, Stall C7",
    shopItems: ["Rice (50kg bag)", "Honey Beans (oloyin)", "Garri (white)", "Palm Oil (5L)", "Indomie (carton)"],
    sellerId: "participant:demo-ngozi",
  },
  {
    storeId: "store:demo-emeka-electronics",
    market: "Computer Village",
    name: "Emeka Phones & Accessories",
    exchangePoint: "Computer Village, Ola-Ayeni Street, Shop 22",
    shopItems: ["USB-C Fast Charger", "Power Bank (20000mAh)", "Bluetooth Earphones", "Screen Protector", "Memory Card (128GB)"],
    sellerId: "participant:demo-emeka",
  },
];

async function waitForEdge() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const res = await fetch(`${edge}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`edge at ${edge} did not answer /healthz — is the dev stack running?`);
}

async function listStores(market) {
  const res = await fetch(`${edge}/markets/${encodeURIComponent(market)}/stores`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET /markets/${market}/stores → HTTP ${res.status}: ${body.message ?? res.statusText}`);
  return body.stores ?? [];
}

async function registerStore(store) {
  const command = {
    type: "store.registered",
    storeId: store.storeId,
    market: store.market,
    name: store.name,
    exchangePoint: store.exchangePoint,
    shopItems: store.shopItems,
  };
  const res = await fetch(`${edge}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-participant-id": store.sellerId,
      "x-participant-role": "seller",
    },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`store.registered ${store.storeId} → HTTP ${res.status}: ${body.message ?? res.statusText}`);
  }
  return body.store;
}

async function main() {
  await waitForEdge();

  // Pre-check what exists so the output distinguishes created vs skipped.
  const markets = [...new Set(STORES.map((s) => s.market))];
  const existing = new Map();
  for (const market of markets) {
    const stores = await listStores(market);
    existing.set(market, new Set(stores.map((s) => s.id)));
  }

  let created = 0;
  let skipped = 0;
  for (const store of STORES) {
    if (existing.get(store.market)?.has(store.storeId)) {
      console.log(`• skip    ${store.name} (${store.market}) — already registered`);
      skipped += 1;
      continue;
    }
    const recorded = await registerStore(store);
    console.log(`✓ created ${recorded.name} (${recorded.market})`);
    console.log(`    id: ${recorded.id}`);
    console.log(`    exchange point: ${recorded.exchangePoint}`);
    console.log(`    shop items: ${recorded.shopItems.join(", ")}`);
    created += 1;
  }

  console.log(`\nseed complete: ${created} created, ${skipped} already present (idempotent).`);
}

main().catch((error) => {
  console.error(`seed FAILED: ${error.message}`);
  process.exit(1);
});
