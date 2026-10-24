import { Link, router } from "expo-router";
import { useState } from "react";
import { Alert, Text, View, Pressable} from "react-native";
import {
  authenticateDeviceKey,
  clearCartState,
  clearDeviceCredentialCache,
  clearSession,
  EDGE_URL,
  setActiveParticipant,
  useActiveMarket,
  useActiveParticipant,
  useAuthSession,
  useDeviceCredential,
  useNotificationSummary,
} from "../src/api";
import { usePoll } from "../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

const roles = [
  { name: "Buyer", role: "buyer" as const, text: "Post an Intent, compare Products and build your Cart.", href: "/buyer" as const, icon: "🧺" },
  { name: "Seller", role: "seller" as const, text: "Match shop items to demand and respond with Products.", href: "/seller" as const, icon: "🏪" },
  { name: "Runner", role: "runner" as const, text: "Collect a Cart and complete each Handoff on your Run.", href: "/runner" as const, icon: "🛵" },
];

export default function Launch() {
  const { participant, loading } = useActiveParticipant();
  const { session, loading: sessionLoading } = useAuthSession();
  const { credential } = useDeviceCredential();
  const notifications = useNotificationSummary();
  const [signingIn, setSigningIn] = useState(false);
  const market = useActiveMarket();
  const health = usePoll(async () => {
    const response = await fetch(`${EDGE_URL}/healthz`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as { service: string };
  }, 5000);

  /** Dev-only logout: clears the onboarded participant, any auth session, the cached device-credential id, and this device's stored cart/run ids (they belong to that identity). */
  const resetIdentity = () => {
    Alert.alert("Reset identity?", "Dev only — clears the onboarded participant, session, device-credential cache, and cart/run state, back to onboarding. The SecureStore secret stays (clearing it would orphan the server-side credential row — the row may linger; revoke server-side if it matters).", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: () => {
          void setActiveParticipant(null).then(() =>
            Promise.all([clearCartState(), clearSession(), clearDeviceCredentialCache()]),
          );
        },
      },
    ]);
  };

  /** One-tap sign-in with the SecureStore device key (no camera needed). */
  const deviceKeySignIn = async () => {
    if (!participant) return;
    setSigningIn(true);
    try {
      await authenticateDeviceKey(participant.id);
    } catch (error) {
      Alert.alert("Device key failed", error instanceof Error ? error.message : String(error));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <Page eyebrow={`Market Runs · ${market}`} title="Good morning">
      <Card style={{ backgroundColor: colors.ink, borderColor: colors.ink, padding: 22 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Pill active>{market.toUpperCase()} · LAGOS</Pill>
          <Pill active={!health.error}>{health.data ? "● LIVE" : health.error ? "● OFFLINE" : "…"}</Pill>
          {participant ? <Pill active>{participant.kycStatus === "verified" ? "✓ VERIFIED" : "KYC FAILED"}</Pill> : null}
        </View>
        <Text style={{ color: "#fff", fontSize: 23, fontWeight: "800", lineHeight: 30, marginTop: 10 }}>
          {participant ? `Welcome back,\n${participant.displayName}.` : "Good errands start\nwith a good run."}
        </Text>
        <Text style={{ color: "#D3DDD5", fontSize: 13, lineHeight: 20 }}>
          {participant
            ? `${participant.role} · ${participant.markets.join(", ")}`
            : "Onboard with BVN/NIN and a facial capture — every role verifies before transacting."}
        </Text>
        {health.error ? (
          <Text style={{ color: "#F2B8A0", fontSize: 12 }}>
            Edge unreachable at {EDGE_URL} — start it with `infra/dev-servers.sh` (or set EXPO_PUBLIC_EDGE_URL).
          </Text>
        ) : null}
      </Card>

      {!loading && !participant ? (
        <Link href="/onboarding" asChild><Button title="Get started — verify your identity" /></Link>
      ) : null}

      {/* Signed-out participant: the cache survived but there's no live session
          (first launch after onboard, expiry, or a server-side 401). */}
      {!loading && !sessionLoading && participant && !session ? (
        <Card style={{ borderColor: colors.green, borderWidth: 2 }}>
          <Pill active>SIGNED OUT</Pill>
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "800" }}>Welcome back, {participant.displayName}.</Text>
          <Text style={s.muted}>Sign in once — your session attaches to every request. No passwords.</Text>
          <Button title="Sign in with face" onPress={() => router.push("/signin")} />
          {credential?.participantId === participant.id ? (
            <Button title={signingIn ? "Signing in…" : "Use this device's key instead"} secondary onPress={deviceKeySignIn} />
          ) : null}
          <Pressable onPress={() => router.push("/device-reset")} style={{ alignSelf: "center", paddingVertical: 4 }}>
            <Text style={{ color: colors.muted, fontSize: 11, textDecorationLine: "underline" }}>Lost access? Request a device reset</Text>
          </Pressable>
        </Card>
      ) : null}

      {participant && session ? <Pill active>✓ SIGNED IN</Pill> : null}

      {participant && session ? (
        <Pressable onPress={() => router.push("/notifications")}>
          <Card>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>Notifications</Text>
                <Text style={s.muted}>{notifications.error ? "Reconnect to refresh activity" : notifications.unread > 0 ? `${notifications.unread} unread update${notifications.unread === 1 ? "" : "s"}` : "You're all caught up"}</Text>
              </View>
              {notifications.unread > 0 ? <Pill active>{notifications.unread}</Pill> : null}
              <Text style={{ color: colors.green }}>→</Text>
            </View>
          </Card>
        </Pressable>
      ) : null}

      <Section title={participant ? "Continue as" : "Explore as (demo)"}>
        <View style={{ gap: 12 }}>
          {roles.map((role) => (
            <Pressable key={role.name} onPress={() => router.push({ pathname: "/markets", params: { role: role.role } })}>
                <Card style={participant?.role === role.role ? { borderColor: colors.green, borderWidth: 2 } : undefined}>
                  <View style={s.row}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
                      <Text style={{ fontSize: 26 }}>{role.icon}</Text>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "800" }}>{role.name}</Text>
                        <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{role.text}</Text>
                      </View>
                    </View>
                    {participant?.role === role.role ? <Pill active>YOU</Pill> : null}
                    <Text style={{ color: colors.green, fontSize: 22 }}>›</Text>
                  </View>
                </Card>
              </Pressable>
          ))}
        </View>
      </Section>

      <Pressable onPress={() => router.push("/markets")}>
<Card>
          <View style={s.row}>
            <View>
              <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>Markets</Text>
              <Text style={s.muted}>Join zones and switch your active market</Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
        </Card>
        </Pressable>
      <Text style={{ color: colors.muted, fontSize: 12, textAlign: "center" }}>Internal runners · Floor Rate delivery</Text>
      {participant ? (
        <Pressable onPress={resetIdentity} style={{ alignSelf: "center", paddingVertical: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 11, textDecorationLine: "underline" }}>Reset identity (dev only)</Text>
        </Pressable>
      ) : null}
    </Page>
  );
}
