import { Stack } from "expo-router";
import { colors } from "../../src/ui";

/** Onboarding: role → profile → KYC. One stack, headers on. */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.paper },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontWeight: "800" },
        contentStyle: { backgroundColor: colors.paper },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Get started" }} />
      <Stack.Screen name="profile" options={{ title: "Your profile" }} />
      <Stack.Screen name="kyc" options={{ title: "Identity verification" }} />
      <Stack.Screen name="face" options={{ title: "Set up sign-in" }} />
    </Stack>
  );
}
