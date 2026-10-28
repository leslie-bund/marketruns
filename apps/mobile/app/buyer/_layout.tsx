import { Link, Tabs } from "expo-router";
import { Pressable, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../src/ui";
import { useBuyerBadges } from "../../src/features/buyer";
import { TransactionRoleGate } from "../../src/features/transaction-role";

/**
 * The buyer's phase guide: Errands → Cart → Track. Tab badges pull attention
 * to whatever needs action right now (offers to review, items awaiting
 * checkout, a delivery QR to show). Phase-detail screens (post, products,
 * negotiation, checkout) push on top and stay out of the tab bar.
 */
function BuyerTabs() {
  const badges = useBuyerBadges();
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
          title: "Buyer",
          tabBarLabel: "Errands",
          ...badge(badges.offers),
          tabBarIcon: ({ color, size }) => <Ionicons name="basket-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: "Your Cart",
          tabBarLabel: "Cart",
          ...badge(badges.cart),
          tabBarIcon: ({ color, size }) => <Ionicons name="cart-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="run"
        options={{
          title: "Track your Run",
          tabBarLabel: "Track",
          ...badge(badges.track),
          tabBarIcon: ({ color, size }) => <Ionicons name="navigate-outline" color={color} size={size} />,
        }}
      />
      {/* Phase-detail screens: reachable, never tabs. */}
      <Tabs.Screen name="post" options={{ href: null, title: "Post an Intent" }} />
      <Tabs.Screen name="products" options={{ href: null, title: "Products" }} />
      <Tabs.Screen name="negotiation" options={{ href: null, title: "Negotiation" }} />
      <Tabs.Screen name="checkout" options={{ href: null, title: "Checkout" }} />
    </Tabs>
  );
}

export default function BuyerLayout() {
  return <TransactionRoleGate role="buyer"><BuyerTabs /></TransactionRoleGate>;
}
