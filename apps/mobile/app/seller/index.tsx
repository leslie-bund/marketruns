import { useEffect, useState } from "react";
import { Link, router } from "expo-router";
import { Image, Text, View, Pressable} from "react-native";
import { getOwnedStore, intentCaptureUrl, participantHeaders, sessionHeaders, setActiveStore, useActiveMarket, useActiveParticipant, useActiveStore } from "../../src/api";
import { PayoutAccountCard, sellerTripBadge, useOpenIntents, useSellerProducts } from "../../src/features/seller";
import { useSellerRun } from "../../src/features/run";
import { ProductVideo } from "../../src/features/product-video";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

export default function SellerHome() {
  const { store, loading } = useActiveStore();
  const { participant } = useActiveParticipant();
  const market = useActiveMarket();
  const intents = useOpenIntents(store?.shopItems ?? null, store?.id);
  const mine = useSellerProducts(store?.name);
  const run = useSellerRun(store);
  const open = intents.data?.filter((intent) => intent.status === "open") ?? [];
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  // Reuse this screen's intent/product subscriptions instead of mounting the
  // tab-badge hook's duplicate discovery sockets and pollers.
  const badges = {
    demand: open.length,
    threads: mine.products.filter((product) => product.status === "negotiating").length,
    trip: sellerTripBadge(run.run, store),
  };

  useEffect(() => {
    if (loading || store || !participant) return;
    let active = true;
    setRecovering(true);
    setRecoveryError(null);
    void getOwnedStore()
      .then(async (owned) => { if (owned) await setActiveStore(owned); })
      .catch((error) => { if (active) setRecoveryError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setRecovering(false); });
    return () => { active = false; };
  }, [loading, store, participant?.id, market, recoveryAttempt]);

  if (!loading && recovering && store === null) {
    return <Page eyebrow="SELLER" title="Finding your store"><Card><Text style={s.body}>Checking for an owned store in {market}…</Text></Card></Page>;
  }

  if (!loading && !recovering && store === null) {
    return (
      <Page eyebrow="SELLER" title="Join your market">
        <Card style={{ backgroundColor: colors.ink, borderColor: colors.ink }}>
          <Pill active>NO OWNED STORE</Pill>
          <Text style={{ color: "white", fontSize: 21, fontWeight: "800" }}>Create your store to start trading.</Text>
        </Card>
        {recoveryError ? <Card><Text style={s.body}>Store recovery failed: {recoveryError}</Text><Button title="Retry recovery" secondary onPress={() => setRecoveryAttempt((value) => value + 1)} /></Card> : null}
        <Link href="/seller/join" asChild><Button title={`Join ${market}`} /></Link>
      </Page>
    );
  }

  return (
    <Page eyebrow={`SELLER · ${market.toUpperCase()}`} title={store?.name ?? "Your Store"}>
      <Card style={{ backgroundColor: colors.ink, borderColor: colors.ink }}>
        <Pill active>STORE ACTIVE · {(store?.exchangePoint ?? "").toUpperCase()}</Pill>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          {intents.presenceError ? `Offline: ${intents.presenceError}` : intents.error ? `Edge: ${intents.error}` : `Online with fresh GPS · intents matching your ${store?.shopItems.length ?? 0} shop item(s).`}
        </Text>
      </Card>

      <Section title="Matching Intents">
        {open.length === 0 ? <Card><Text style={s.muted}>No open intents for your items right now.</Text></Card> : null}
        {open.map((intent) => (
          <Card key={intent.id}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>{intent.quantity} {intent.unit} {intent.shopItem}</Text>
                <Text style={s.muted}>Buyer Price Band · {money(intent.priceBand.minKobo)}–{money(intent.priceBand.maxKobo)}</Text>
              </View>
              <Pill active>MATCH</Pill>
            </View>
            {intent.note ? <Text style={s.body}>{intent.note}</Text> : null}
            {intent.photoCaptureRef ? <View style={{ height: 180, overflow: "hidden", borderRadius: 14 }}><Image source={{ uri: intentCaptureUrl(intent.market, intent.id), headers: { ...sessionHeaders(), ...participantHeaders() } }} style={{ flex: 1 }} resizeMode="cover" /></View> : null}
            {intent.videoCaptureRef ? <ProductVideo uri={intentCaptureUrl(intent.market, intent.id, "video")} /> : null}
            <Link
              href={{ pathname: "/seller/respond", params: { intentId: intent.id, shopItem: intent.shopItem, quantity: String(intent.quantity), unit: intent.unit } }}
              asChild
            >
              <Button title="Respond with Product" />
            </Link>
          </Card>
        ))}
      </Section>

      <Pressable onPress={() => router.push("/seller/negotiations")}>
        <Card>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>Active Negotiations</Text>
              <Text style={s.muted}>{mine.products.length} live product(s)</Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
        </Card>
      </Pressable>

      <Pressable onPress={() => router.push("/seller/trip")}>
        <Card style={badges.trip > 0 ? { borderColor: colors.orange, borderWidth: 2 } : undefined}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>Trip & Handoffs</Text>
              <Text style={badges.trip > 0 ? { color: colors.orange, fontWeight: "700", fontSize: 13 } : s.muted}>
                {badges.trip > 0 ? "Runner waiting — show the QR now" : "Show the one-time QR when a runner arrives"}
              </Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
        </Card>
      </Pressable>

      {participant ? <Section title="Payouts"><PayoutAccountCard participantId={participant.id} /></Section> : null}
    </Page>
  );
}
