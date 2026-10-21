import { Link, Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../src/ui";
import { useActiveStore } from "../../src/api";
import { useSellerBadges } from "../../src/features/seller";

/**
 * The seller's phase guide: Demand → Offers → Trip. Tab badges pull attention
 * to whatever needs action right now (fresh intents, threads mid-negotiation,
 * a runner waiting for the QR). Detail screens (respond, negotiation) push
 * on top and stay out of the tab bar.
 */
export default function SellerLayout() {
  const { store } = useActiveStore();
  const badges = useSellerBadges(store);
  // exactOptionalPropertyTypes: hide the badge by omitting the prop entirely.
  const badge = (count: number) => (count > 0 ? { tabBarBadge: count } : {});

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.paper },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontWeight: "800" },
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.paper },
        headerRight: () => (
          <Link href="/" asChild>
            <Pressable style={{ paddingRight: 12 }}>
              <Text style={{ color: colors.green, fontWeight: "700" }}>Switch role</Text>
            </Pressable>
          </Link>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Seller",
          tabBarLabel: "Demand",
          ...badge(badges.demand),
          tabBarIcon: ({ color, size }) => <Ionicons name="storefront-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="negotiations"
        options={{
          title: "Negotiations",
          tabBarLabel: "Offers",
          ...badge(badges.threads),
          tabBarIcon: ({ color, size }) => <Ionicons name="pricetags-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="trip"
        options={{
          title: "Trip",
          tabBarLabel: "Trip",
          ...badge(badges.trip),
          tabBarIcon: ({ color, size }) => <Ionicons name="map-outline" color={color} size={size} />,
        }}
      />
      {/* Phase-detail screens: reachable, never tabs. */}
      <Tabs.Screen name="respond" options={{ href: null, title: "Respond to Intent" }} />
      <Tabs.Screen name="negotiation" options={{ href: null, title: "Negotiation" }} />
      <Tabs.Screen name="join" options={{ href: null, title: "Join the Market" }} />
    </Tabs>
  );
}
