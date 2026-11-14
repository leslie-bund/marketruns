import { and, desc, eq } from "drizzle-orm";
import { CartSchema, ParticipantHistorySchema, ProductSchema, type ParticipantHistory } from "@market-runs/proto";
import { archivedProducts, cartsArchive, runsArchive } from "../../../infra/drizzle/schema.js";
import type { ArchiveTx } from "./persist.js";
import { adminRunSummary } from "./admin.js";

export function parseParticipantHistoryQuery(url: URL): { participantId: string; role: "buyer" | "seller" | "runner" } | Response {
  const participantId = url.searchParams.get("participantId");
  const role = url.searchParams.get("role");
  if (!participantId || (role !== "buyer" && role !== "seller" && role !== "runner")) {
    return Response.json({ error: "invalid-query", message: "participantId and a valid role are required" }, { status: 400 });
  }
  return { participantId, role };
}

export async function loadParticipantHistory(
  tx: ArchiveTx,
  query: { participantId: string; role: "buyer" | "seller" | "runner" },
): Promise<ParticipantHistory> {
  const carts: ParticipantHistory["carts"] = [];
  const sales: ParticipantHistory["sales"] = [];
  let runs: ParticipantHistory["runs"] = [];

  if (query.role === "buyer") {
    const rows = await tx.select({ cart: cartsArchive, run: runsArchive }).from(cartsArchive)
      .leftJoin(runsArchive, eq(cartsArchive.cartId, runsArchive.cartId))
      .where(eq(cartsArchive.buyerId, query.participantId))
      .orderBy(desc(cartsArchive.retiredAt)).limit(200);
    for (const row of rows) {
      const snapshot = CartSchema.parse(row.cart.snapshot);
      carts.push({
        id: row.cart.id,
        cartId: row.cart.cartId,
        market: row.cart.marketId,
        reason: row.cart.reason as CartRetirementReason,
        products: snapshot.products,
        firstAcceptedAt: snapshot.firstAcceptedAt,
        deadline: snapshot.deadline,
        retiredAt: row.cart.retiredAt.getTime(),
        runId: row.run?.id ?? null,
      });
    }
    runs = (await tx.select().from(runsArchive).where(eq(runsArchive.buyerId, query.participantId))
      .orderBy(desc(runsArchive.closedAt)).limit(200)).map(adminRunSummary);
  }

  if (query.role === "runner") {
    runs = (await tx.select().from(runsArchive).where(eq(runsArchive.runnerId, query.participantId))
      .orderBy(desc(runsArchive.closedAt)).limit(200)).map(adminRunSummary);
  }

  if (query.role === "seller") {
    const rows = await tx.select({ product: archivedProducts, run: runsArchive }).from(archivedProducts)
      .leftJoin(runsArchive, eq(archivedProducts.cartId, runsArchive.cartId))
      .where(and(eq(archivedProducts.sellerParticipantId, query.participantId), eq(archivedProducts.retirementReason, "accepted")))
      .orderBy(desc(archivedProducts.retiredAt)).limit(200);
    for (const row of rows) {
      const product = ProductSchema.parse(row.product.finalState);
      sales.push({
        productId: row.product.id,
        intentId: row.product.intentId,
        cartId: row.product.cartId,
        runId: row.run?.id ?? null,
        market: row.product.marketId,
        shopItem: product.shopItem,
        quantity: row.product.quantity,
        unit: product.unit,
        priceKobo: row.product.finalPriceKobo,
        soldAt: row.product.retiredAt.getTime(),
      });
    }
    const sellerRuns = await tx.selectDistinct({ run: runsArchive }).from(runsArchive)
      .innerJoin(archivedProducts, eq(archivedProducts.cartId, runsArchive.cartId))
      .where(and(eq(archivedProducts.sellerParticipantId, query.participantId), eq(archivedProducts.retirementReason, "accepted")))
      .orderBy(desc(runsArchive.closedAt)).limit(200);
    runs = sellerRuns.map((row) => adminRunSummary(row.run));
  }

  return ParticipantHistorySchema.parse({ carts, sales, runs });
}

type CartRetirementReason = ParticipantHistory["carts"][number]["reason"];
