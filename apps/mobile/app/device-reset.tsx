import { useRef, useState } from "react";
import { router } from "expo-router";
import { Alert, Platform, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { DEV_FACE_IMAGE_BASE64, captureFaceSequence, getParticipant, recoverDevice, setActiveParticipant, useActiveParticipant } from "../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, s } from "../src/ui";
import { devDemoMode } from "../src/api/dev-mode";

/** Self-service recovery: participant id + fresh liveness + 1:1 match. */
export default function DeviceReset() {
  const { participant } = useActiveParticipant();
  const [participantId, setParticipantId] = useState(participant?.id ?? "");
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState(false);

  const submit = async (capture: { image: string; livenessImages: string[] }) => {
    if (!participantId.trim() || !consented) return;
    setBusy(true);
    try {
      const recoveredId = participantId.trim();
      if (participant && participant.id !== recoveredId) await setActiveParticipant(null);
      await recoverDevice({ ...capture, participantId: recoveredId, deviceLabel: `${Platform.OS} replacement device` });
      const recoveredParticipant = await getParticipant(recoveredId);
      if (!recoveredParticipant) throw new Error("Recovery succeeded, but your participant profile could not be loaded. Check your connection and reopen the app.");
      await setActiveParticipant(recoveredParticipant);
      Alert.alert("Device recovered", "Your old device keys and sessions were revoked. This device is now signed in.");
      router.replace("/");
    } catch (error) { Alert.alert("Recovery failed", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const capture = async () => { try { await submit(await captureFaceSequence(camera)); }
    catch (error) { Alert.alert("Capture failed", error instanceof Error ? error.message : String(error)); } };
  const devCapture = { image: DEV_FACE_IMAGE_BASE64, livenessImages: Array(7).fill(DEV_FACE_IMAGE_BASE64) as string[] };

  return (
    <Page eyebrow="DEVICE RECOVERY" title="Prove it’s you">
      <Card><Pill active>FRESH LIVENESS + 1:1 MATCH</Pill><Text style={s.body}>
        Email cannot recover your account. Enter your participant id and complete a new seven-frame face check. Success revokes old keys and sessions before registering this device.
      </Text></Card>
      <Section title="Participant"><Label>Participant id</Label>
        <Field value={participantId} onChangeText={setParticipantId} autoCapitalize="none" placeholder="participant-…" /></Section>
      <Section title="Consent and capture">
        <Text style={s.muted}>Consent biometric-capture-v2: fresh frames are sent to the private identity service for liveness and comparison with your enrolled face. Recovery images are transit-only, are not sent to Smile ID, and no 1:N search occurs.</Text>
        <Button title={consented ? "✓ Consent recorded for this capture" : "I consent to this biometric recovery"} secondary onPress={() => setConsented(true)} />
        {!permission?.granted ? <Button title="Allow camera" onPress={requestPermission} /> : <>
          <View style={{ height: 220, overflow: "hidden", borderRadius: 18 }}><CameraView ref={camera} style={{ flex: 1 }} facing="front" /></View>
          <Button title={busy ? "Recovering…" : "Capture 7 frames and recover"} onPress={() => { if (consented && !busy) void capture(); }} />
          {devDemoMode ? <Button title="Use dev capture (stub only)" secondary onPress={() => { if (consented && !busy) void submit(devCapture); }} /> : null}
        </>}
      </Section>
      <Button title="Back" secondary onPress={() => router.back()} />
    </Page>
  );
}
