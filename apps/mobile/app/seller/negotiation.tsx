import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Alert, Text, View } from "react-native";
import { getProduct, sellerOffer, useLiveEvents, usePoll } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors, money, s, timeAgo } from "../../src/ui";
import { ProductVideo } from "../../src/features/product-video";
import { productCaptureUrl } from "../../src/api";

/** The seller's side of the 1:1 thread — same product, `by: "seller"` moves. */
export default function SellerNegotiation() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const thread = usePoll(() => getProduct(productId), 15000);
  const live = useLiveEvents(`/products/${encodeURIComponent(productId)}`, () => thread.refresh(), () => thread.refresh());
  const [offer, setOffer] = useState("");
  const [busy, setBusy] = useState(false);
  const current = thread.data?.product ?? null;
  const history = thread.data?.priceHistory ?? [];
  const lastMove = history.length > 0 ? history[history.length - 1] : null;

  const sendOffer = async () => {
    const priceKobo = Math.round(Number(offer) * 100);
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) return;
    setBusy(true);
    try {
      await sellerOffer(productId, priceKobo);
      setOffer("");
      thread.refresh();
    } catch (error) {
      Alert.alert("Could not adjust", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`PRIVATE · 1:1 · ${live ? "LIVE" : "POLLING"}`} title={current?.shopItem ?? "Negotiation"}>
      {lastMove?.by === "buyer" && current?.status !== "accepted" ? (
        <Card style={{ backgroundColor: colors.green, borderColor: colors.green }}>
          <Text style={{ color: "white", fontWeight: "700" }}>Buyer updated the price — your turn.</Text>
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

      {current?.videoCaptureRef ? <Section title="Product video"><ProductVideo uri={productCaptureUrl(current.id, "video")} /></Section> : null}

      <Section title="Price history">
        {history.length === 0 ? <Card><Text style={s.muted}>No moves yet.</Text></Card> : null}
        {[...history].reverse().map((move, index) => (
          <Card key={`${move.at}-${index}`}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontWeight: "800" }}>
                  {move.by === "seller" ? "You" : "Buyer"}
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
        <Pill active>Accepted · in buyer's Cart</Pill>
      ) : (
        <Section title="Adjust the price">
          <Label>Your counter (₦)</Label>
          <Field value={offer} onChangeText={setOffer} keyboardType="decimal-pad" placeholder={current ? String(current.priceKobo / 100) : "0"} />
          <Button title={busy ? "Sending…" : "Send counter"} onPress={sendOffer} />
        </Section>
      )}
    </Page>
  );
}
