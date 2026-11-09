import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Text, View } from "react-native";
import { acceptProduct, buyerOffer, getProduct, useLiveEvents, usePoll } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors, money, s, timeAgo } from "../../src/ui";

/**
 * The 1:1 negotiation (ADR-0002): one buyer, one seller, one product. The
 * price either side sets is the product's price — the thread IS the product
 * state. Live updates arrive over the product's WebSocket; polling is the
 * fallback.
 */
export default function NegotiationThread() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const thread = usePoll(() => getProduct(productId), 15000);
  const live = useLiveEvents(`/products/${encodeURIComponent(productId)}`, () => thread.refresh(), () => thread.refresh());
  const [offer, setOffer] = useState("");
  const [busy, setBusy] = useState(false);

  if (thread.data === null && thread.error) {
    return (
      <Page eyebrow="PRIVATE · 1:1" title="Negotiation">
        <Card><Text style={s.body}>{thread.error}</Text></Card>
      </Page>
    );
  }
  const current = thread.data?.product ?? null;
  const history = thread.data?.priceHistory ?? [];
  const lastMove = history.length > 0 ? history[history.length - 1] : null;
  const waitingOn = lastMove?.by === "buyer" ? "seller" : lastMove?.by === "seller" ? "you" : null;

  const sendOffer = async () => {
    const priceKobo = Math.round(Number(offer) * 100);
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) return;
    setBusy(true);
    try {
      await buyerOffer(productId, priceKobo);
      setOffer("");
      thread.refresh();
    } catch (error) {
      Alert.alert("Could not adjust", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    try {
      const cart = await acceptProduct(productId);
      Alert.alert(
        "Added to Cart",
        `The shared Cart deadline moved to ${new Date(cart.deadline).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}.`,
        [{ text: "View Cart", onPress: () => router.replace("/buyer/cart") }],
      );
    } catch (error) {
      Alert.alert("Could not accept", error instanceof Error ? error.message : String(error));
      thread.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`PRIVATE · 1:1 · ${live ? "LIVE" : "POLLING"}`} title={current?.shopItem ?? "Negotiation"}>
      {waitingOn !== null && current?.status !== "accepted" ? (
        <Card style={{ backgroundColor: colors.green, borderColor: colors.green }}>
          <Text style={{ color: "white", fontWeight: "700" }}>
            {waitingOn === "you" ? "Seller updated the price — your turn." : "Waiting on the seller…"}
          </Text>
        </Card>
      ) : null}

      <Section title="Current terms">
        <Card>
          <View style={s.row}>
            <View>
              <Text style={{ color: colors.ink, fontSize: 22, fontWeight: "900" }}>{current ? money(current.priceKobo) : "…"}</Text>
              <Text style={s.muted}>{current?.quantity} {current?.unit} · {current?.exchangePoint}</Text>
            </View>
            <Pill active>{current?.status?.toUpperCase() ?? "…"}</Pill>
          </View>
        </Card>
      </Section>

      <Section title="Price history">
        {history.length === 0 ? <Card><Text style={s.muted}>No moves yet.</Text></Card> : null}
        {[...history].reverse().map((move, index) => (
          <Card key={`${move.at}-${index}`}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontWeight: "800" }}>
                  {move.by === "buyer" ? "You" : current?.sellerName ?? "Seller"}
                  {index === 0 ? " · latest" : ""}
                </Text>
                <Text style={s.muted}>{timeAgo(move.at)}</Text>
              </View>
              <Text style={{ color: colors.ink, fontSize: 18, fontWeight: "900" }}>{money(move.priceKobo)}</Text>
            </View>
          </Card>
        ))}
      </Section>

      {current?.status === "accepted" ? (
        <Pill active>This product is in your Cart</Pill>
      ) : (
        <Section title="Adjust the price">
          <Label>Your offer (₦)</Label>
          <Field value={offer} onChangeText={setOffer} keyboardType="decimal-pad" placeholder={current ? String(current.priceKobo / 100) : "0"} />
          <Button title={busy ? "Sending…" : "Send price"} onPress={sendOffer} />
          <Button title="Accept Product" secondary onPress={accept} />
        </Section>
      )}
    </Page>
  );
}
