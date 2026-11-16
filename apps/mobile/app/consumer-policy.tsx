import { useState } from "react";
import { router } from "expo-router";
import { Alert, Linking, Pressable, Text } from "react-native";
import { CONSUMER_POLICY, CONSUMER_POLICY_VERSION } from "@market-runs/proto";
import { acceptConsumerPolicy, setActiveParticipant, useActiveParticipant, useAuthSession } from "../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

export default function ConsumerPolicyScreen() {
  const { participant } = useActiveParticipant();
  const { session } = useAuthSession();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const accepted = participant?.consumerPolicyVersion === CONSUMER_POLICY_VERSION && Boolean(participant.consumerPolicyAcceptedAt);

  const accept = async () => {
    if (!participant || !session || !confirmed) return;
    setBusy(true);
    try {
      const result = await acceptConsumerPolicy(participant.id, CONSUMER_POLICY_VERSION);
      await setActiveParticipant(result.participant);
      Alert.alert("Policy acknowledged", "Your acceptance has been recorded.");
      router.replace("/");
    } catch (error) {
      Alert.alert("Could not record acceptance", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`${CONSUMER_POLICY.version} · EFFECTIVE ${CONSUMER_POLICY.effectiveDate}`} title={CONSUMER_POLICY.title}>
      <Card style={{ backgroundColor: colors.ink }}>
        <Text style={{ color: "#FFFFFF", fontWeight: "800" }}>Your statutory rights continue</Text>
        <Text style={{ color: "#D3DDD5", lineHeight: 20 }}>
          The in-app dispute window helps pause settlement quickly. It does not end your consumer rights, including eligible refunds after that window.
        </Text>
      </Card>

      {CONSUMER_POLICY.sections.map((section) => (
        <Section key={section.title} title={section.title}>
          <Text style={s.body}>{section.body}</Text>
        </Section>
      ))}

      <Button title="FCCPC complaint guidance" secondary onPress={() => void Linking.openURL(CONSUMER_POLICY.fccpcUrl)} />
      <Button title="Email Market Runs support" secondary onPress={() => void Linking.openURL("mailto:info@updates.marketruns.org")} />

      {participant && session ? (
        accepted ? (
          <Card><Pill active>POLICY ACKNOWLEDGED</Pill><Text style={s.muted}>Version {CONSUMER_POLICY_VERSION} is recorded for this participant.</Text></Card>
        ) : (
          <Section title="Acknowledge this version">
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed((value) => !value)}>
              <Card style={{ borderColor: confirmed ? colors.green : colors.line }}>
                <Text style={s.body}>{confirmed ? "✓ " : ""}I have read and acknowledge the Consumer, returns and refund policy ({CONSUMER_POLICY_VERSION}).</Text>
              </Card>
            </Pressable>
            <Button title={busy ? "Recording…" : "Record my acknowledgement"} disabled={!confirmed || busy} onPress={() => void accept()} />
          </Section>
        )
      ) : (
        <Card><Text style={s.muted}>Sign in to record your acknowledgement. New participants acknowledge this policy during identity verification.</Text></Card>
      )}
      <Button title="Back" secondary onPress={() => router.back()} />
    </Page>
  );
}
