import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { listMarkets, usePoll } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors } from "../../src/ui";

/**
 * Onboarding step 2: display name + the market you trade in (GLOSSARY:
 * Market — a named zone locals recognize). The zone list comes from the
 * edge's markets index.
 */
export default function OnboardingProfile() {
  const { role } = useLocalSearchParams<{ role: string }>();
  const markets = usePoll(listMarkets, 30000);
  const [name, setName] = useState("");
  const [market, setMarket] = useState("Balogun");

  const proceed = () => {
    if (!name.trim()) return;
    router.push({
      pathname: "/onboarding/kyc",
      params: { role: role ?? "buyer", displayName: name.trim(), market },
    });
  };

  return (
    <Page eyebrow={`ONBOARDING · ${(role ?? "").toUpperCase()}`} title="Your profile">
      <Section title="Display name">
        <Label>Shown to counterparties in negotiations and handoffs</Label>
        <Field value={name} onChangeText={setName} placeholder="e.g. Amina" autoFocus />
      </Section>

      <Section title="Your market">
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Markets are named zones with their own opening hours — you join one now and can join more later.
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(markets.data ?? []).map((entry) => (
            <Pressable key={entry.id} onPress={() => setMarket(entry.id)}>
              <Pill active={market === entry.id}>{entry.id}</Pill>
            </Pressable>
          ))}
        </View>
        {markets.data === null ? <Card><Text style={{ color: colors.muted }}>Loading markets…</Text></Card> : null}
      </Section>

      <Button title="Continue to verification" onPress={proceed} />
    </Page>
  );
}
