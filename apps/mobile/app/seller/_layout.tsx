import { Stack, Link } from "expo-router";
import { Pressable, Text } from "react-native";
import { colors } from "../../src/ui";
export default function SellerLayout() { return <Stack screenOptions={{ headerShown: true, headerStyle: { backgroundColor: colors.paper }, headerTintColor: colors.ink, headerTitleStyle: { fontWeight: "800" }, headerRight: () => <Link href="/" asChild><Pressable><Text style={{ color: colors.green, fontWeight: "700" }}>Switch role</Text></Pressable></Link> }}><Stack.Screen name="index" options={{ title: "Seller" }} /><Stack.Screen name="respond" options={{ title: "Respond to Intent" }} /><Stack.Screen name="negotiations" options={{ title: "Negotiations" }} /></Stack>; }
