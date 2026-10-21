import { useState } from "react";
import { router } from "expo-router";
import { Alert, Text } from "react-native";
import { requestDeviceReset, useActiveParticipant } from "../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, s } from "../src/ui";

/**
 * Lost-device path: ask ops to reset this participant's device access. The
 * request lands as "pending" and is approved server-side — this screen shows
 * exactly that state and nothing more.
 */
export default function DeviceReset() {
  const { participant } = useActiveParticipant();
  const [participantId, setParticipantId] = useState(participant?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState<{ id: string; status: string } | null>(null);

  const submit = async () => {
    if (!participantId.trim() || !reason.trim()) {
      Alert.alert("Almost there", "We need the participant id and a short reason.");
      return;
    }
    setBusy(true);
    try {
      setRequested(await requestDeviceReset({ participantId: participantId.trim(), reason: reason.trim() }));
    } catch (error) {
      Alert.alert("Request failed", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (requested) {
    return (
      <Page eyebrow="DEVICE RESET" title="Request sent">
        <Card>
          <Pill active>{requested.status.toUpperCase()} · OPS REVIEW</Pill>
          <Text style={s.body}>
            Your reset request is in. Ops reviews and approves it — once approved, onboard this device again to get a new key.
          </Text>
          <Text style={s.muted}>Request {requested.id}</Text>
        </Card>
        <Button title="Back to start" onPress={() => router.replace("/")} />
      </Page>
    );
  }

  return (
    <Page eyebrow="DEVICE RESET" title="Lost access?">
      <Card>
        <Text style={s.body}>
          If you lost your phone or the key on it no longer works, request a device reset. Ops reviews every request before anything changes.
        </Text>
      </Card>
      <Section title="Participant">
        <Label>Participant id (prefilled from this device)</Label>
        <Field value={participantId} onChangeText={setParticipantId} autoCapitalize="none" placeholder="participant-…" />
      </Section>
      <Section title="Reason">
        <Label>What happened?</Label>
        <Field value={reason} onChangeText={setReason} placeholder="e.g. Lost my phone at the market" multiline />
      </Section>
      <Button title={busy ? "Sending…" : "Request a device reset"} danger onPress={submit} />
      <Button title="Back" secondary onPress={() => router.back()} />
    </Page>
  );
}
