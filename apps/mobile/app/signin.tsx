import { useRef, useState } from "react";
import { router } from "expo-router";
import { Alert, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  AuthError, DEV_FACE_IMAGE_BASE64, authenticateDeviceKey, captureFaceSequence,
  useActiveParticipant, useDeviceCredential, verifyFace,
} from "../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

export default function SignIn() {
  const { participant } = useActiveParticipant(); const { credential } = useDeviceCredential();
  const [permission, requestPermission] = useCameraPermissions(); const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const hasDeviceKey = participant !== null && credential?.participantId === participant.id;

  const submit = async (capture: { image: string; livenessImages: string[] }) => {
    if (!participant || !consented) return; setBusy(true); setProblem(null);
    try { await verifyFace({ ...capture, participantId: participant.id }); router.replace("/"); }
    catch (error) {
      if (error instanceof AuthError && error.code === "face-mismatch") setProblem("Not a close enough match — try again in better light.");
      else if (error instanceof AuthError && error.code === "too-many-attempts") setProblem("Too many failed attempts. Wait 15 minutes before trying again.");
      else Alert.alert("Sign-in failed", error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const capture = async () => { try { await submit(await captureFaceSequence(camera)); }
    catch (error) { Alert.alert("Capture failed", error instanceof Error ? error.message : String(error)); } };
  const deviceKeySignIn = async () => {
    if (!participant) return; setBusy(true);
    try { await authenticateDeviceKey(participant.id); router.replace("/"); }
    catch (error) { Alert.alert("Device key failed", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!participant) return <Page eyebrow="SIGN IN" title="Welcome back"><Card><Text style={s.body}>Onboard first, or recover a participant on this device.</Text></Card></Page>;
  const devCapture = { image: DEV_FACE_IMAGE_BASE64, livenessImages: Array(7).fill(DEV_FACE_IMAGE_BASE64) as string[] };
  return (
    <Page eyebrow="SIGN IN" title={`Welcome back, ${participant.displayName}`}>
      <Card style={{ backgroundColor: colors.ink }}><Pill active>NO PASSWORDS</Pill>
        <Text style={{ color: "white", fontSize: 19, fontWeight: "800" }}>Seven fresh frames. One participant-specific match.</Text></Card>
      {problem ? <Card style={{ borderColor: colors.orange }}><Text style={s.body}>{problem}</Text></Card> : null}
      <Section title="Face sign-in">
        <Text style={s.muted}>Consent biometric-capture-v1: captures are used for liveness and 1:1 sign-in only. Images are transit-only and are never used for 1:N search.</Text>
        <Button title={consented ? "✓ Consent recorded for this capture" : "I consent to biometric sign-in"} secondary onPress={() => setConsented(true)} />
        {!permission?.granted ? <Button title="Allow camera" onPress={requestPermission} /> : <>
          <View style={{ height: 240, overflow: "hidden", borderRadius: 18 }}><CameraView ref={camera} style={{ flex: 1 }} facing="front" /></View>
          <Button title={busy ? "Verifying…" : "Capture 7 frames and sign in"} onPress={() => { if (consented && !busy) void capture(); }} />
          <Button title="Use dev capture (stub only)" secondary onPress={() => { if (consented && !busy) void submit(devCapture); }} />
        </>}
      </Section>
      {hasDeviceKey ? <Button title="Use this device’s key instead" secondary onPress={deviceKeySignIn} /> : null}
      <Button title="Lost access? Recover this device" secondary danger onPress={() => router.push("/device-reset")} />
      <Button title="Back" secondary onPress={() => router.replace("/")} />
    </Page>
  );
}
