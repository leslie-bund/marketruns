import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Button, Card, Page, Section, colors, s } from "../../src/ui";

const roles = [
  { role: "buyer" as const, name: "Buyer", text: "Post intents, negotiate, and get one run for your whole cart.", icon: "🧺" },
  { role: "seller" as const, name: "Seller", text: "Register a store, list your shop items, and answer demand near you.", icon: "🏪" },
  { role: "runner" as const, name: "Runner", text: "Collect carts and complete QR-challenge handoffs on your run.", icon: "🛵" },
];

/**
 * Onboarding step 1: pick a role. Every role completes full identity
 * verification before transacting (ADR-0004) — buyers included.
 */
export default function OnboardingRole() {
  return (
    <Page eyebrow="MARKET RUNS" title="Who are you?">
      <Card style={{ backgroundColor: colors.ink, borderColor: colors.ink }}>
        <Text style={{ color: "#DAF26B", fontWeight: "800" }}>EVERYONE VERIFIES</Text>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "800" }}>One identity, one market, real handoffs.</Text>
        <Text style={{ color: "#D3DDD5", fontSize: 13, lineHeight: 19 }}>
          Buyers, sellers, and runners all complete BVN/NIN verification with a facial capture. It takes a minute.
        </Text>
      </Card>
      <Section title="Continue as">
        <View style={{ gap: 12 }}>
          {roles.map((entry) => (
            <Pressable
              key={entry.role}
              onPress={() => router.push({ pathname: "/onboarding/profile", params: { role: entry.role } })}
            >
              <Card>
                <View style={s.row}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
                    <Text style={{ fontSize: 26 }}>{entry.icon}</Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "800" }}>{entry.name}</Text>
                      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{entry.text}</Text>
                    </View>
                  </View>
                  <Text style={{ color: colors.green, fontSize: 22 }}>›</Text>
                </View>
              </Card>
            </Pressable>
          ))}
        </View>
      </Section>
      <Button title="Already onboarded? Back to start" secondary onPress={() => router.replace("/")} />
    </Page>
  );
}
