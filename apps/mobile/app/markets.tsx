import { useState } from "react";
import { router } from "expo-router";
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
  const [busy, setBusy] = useState<string | null>(null);

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
      router.back();
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

      <Section title="Open zones">
        {(markets.data ?? []).map((market) => {
          const joined = participant?.markets.includes(market.id) ?? false;
          const isActive = active === market.id;
          return (
            <Pressable
              key={market.id}
              onPress={async () => {
                await setActiveMarket(market.id);
                router.back();
              }}
            >
              <Card style={isActive ? { borderColor: colors.green, borderWidth: 2 } : undefined}>
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>{market.id}</Text>
                    <Text style={s.muted}>{joined ? "Member" : "Not joined"}</Text>
                  </View>
                  {isActive ? <Pill active>ACTIVE</Pill> : null}
                  {joined ? <Pill active>JOINED</Pill> : null}
                </View>
                {!joined ? (
                  <Button title={busy === market.id ? "Joining…" : "Join this market"} secondary onPress={() => join(market.id)} />
                ) : null}
              </Card>
            </Pressable>
          );
        })}
        {markets.data === null ? <Card><Text style={s.muted}>Loading markets…</Text></Card> : null}
      </Section>
    </Page>
  );
}
