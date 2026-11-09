import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Button, Card, Page, Section, colors, s } from "../../src/ui";

const roles = [
  { role: "buyer" as const, name: "Buyer", icon: "🧺" },
  { role: "seller" as const, name: "Seller", icon: "🏪" },
  { role: "runner" as const, name: "Runner", icon: "🛵" },
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
        <Text style={{ color: "#D3DDD5", fontSize: 13, lineHeight: 19 }}>
          Buyers, sellers, and runners all complete BVN/NIN verification with a facial capture.
        </Text>
      </Card>
      <Section title="Continue as">
        <View style={{ gap: 12 }}>
          {roles.map((entry) => (
            <Pressable
              key={entry.role}
              accessibilityRole="link"
              accessibilityLabel={`Continue as ${entry.name}`}
              onPress={() => router.push({ pathname: "/onboarding/profile", params: { role: entry.role } })}
            >
              <Card>
                <View style={s.row}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
                    <Text style={{ fontSize: 26 }}>{entry.icon}</Text>
                    <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "800", flex: 1 }}>{entry.name}</Text>
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
