import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import {
  joinMarket,
  listMarkets,
  setActiveMarket,
  useActiveMarket,
  useActiveParticipant,
  usePoll,
} from "../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

/**
 * The zone list (GLOSSARY: Market — named zones, never geohash cells,
 * ADR-0001). Every role joins markets here; the active market drives every
 * scoped read and command on the device. Sellers create a store per market
 * after joining.
 */
export default function Markets() {
  const markets = usePoll(listMarkets, 15000);
  const active = useActiveMarket();
  const { participant } = useActiveParticipant();
  const { role } = useLocalSearchParams<{ role?: "buyer" | "seller" | "runner" }>();
  const [busy, setBusy] = useState<string | null>(null);
  const destination = role === "seller" ? "/seller" : role === "runner" ? "/runner" : "/buyer";
  const finish = () => role ? router.replace(destination) : router.back();

  const join = async (marketId: string) => {
    if (!participant) {
      Alert.alert("Onboard first", "Join a market after identity verification.", [
        { text: "Get started", onPress: () => router.push("/onboarding") },
        { text: "Cancel", style: "cancel" },
      ]);
      return;
    }
    setBusy(marketId);
    try {
      await joinMarket(marketId);
      await setActiveMarket(marketId);
      finish();
    } catch (error) {
      Alert.alert("Could not join", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page eyebrow="ZONES · LAGOS" title="Markets">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>{`ACTIVE · ${active.toUpperCase()}`}</Pill>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "800" }}>Pick your market zone.</Text>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          Carts never cross market boundaries — one runner, one market, one trip.
        </Text>
      </Card>

      <Section title={role ? `Choose a market for ${role}` : "Open zones"}>
        {(markets.data ?? []).map((market) => {
          const joined = participant?.markets.includes(market.id) ?? false;
          const isActive = active === market.id;
          return (
            <Pressable key={market.id} onPress={async () => { await setActiveMarket(market.id); finish(); }}>
              <Card style={isActive ? { borderColor: colors.green, borderWidth: 2 } : undefined}>
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>{market.name}</Text>
                    <Text style={s.muted}>{market.opensAt}–{market.closesAt} · {joined ? "Member" : "Not joined"}</Text>
                  </View>
                  {isActive ? <Pill active>ACTIVE</Pill> : null}
                  {joined ? <Pill active>JOINED</Pill> : null}
                </View>
                <Pill active={market.onlineSellers > 0}>{market.onlineSellers} seller{market.onlineSellers === 1 ? "" : "s"} online now</Pill>
                {!joined ? <Button title={busy === market.id ? "Joining…" : "Join this market"} secondary onPress={() => join(market.id)} /> : null}
              </Card>
            </Pressable>
          );
        })}
        {markets.data === null && !markets.error ? <Card><Text style={s.muted}>Loading markets…</Text></Card> : null}
        {markets.error ? <Card><Text style={s.body}>Could not load markets: {markets.error}</Text><Button title="Retry" onPress={markets.refresh} /></Card> : null}
      </Section>
    </Page>
  );
}
