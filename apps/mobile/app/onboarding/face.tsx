import { useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Platform, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  awaitFaceJob, captureFaceSequence, confirmDisplayName, enrollFace,
  isFaceJobPending, registerDeviceKey, useActiveParticipant,
} from "../../src/api";
import { Button, Card, Field, Label, Page, Section, s } from "../../src/ui";

export default function OnboardingFace() {
  const params = useLocalSearchParams<{ role?: string; enrollmentProof?: string; docType?: string; docNumber?: string }>();
  const role = (params.role ?? "buyer") as "buyer" | "seller" | "runner";
  const { participant } = useActiveParticipant(); const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null); const [busy, setBusy] = useState(false);
  const [consented, setConsented] = useState(false); const [enrolled, setEnrolled] = useState(false);
  const [displayName, setDisplayName] = useState(participant?.displayName ?? ""); const [keyState, setKeyState] = useState("");
  const onward = () => router.replace(role === "seller" ? "/seller/join" : `/${role}`);

  const finish = async (suggestedName?: string) => {
    if (suggestedName) setDisplayName(suggestedName);
    setEnrolled(true); setKeyState("Registering this device…");
    try {
      if (!participant || !params.enrollmentProof) throw new Error("Missing enrollment proof");
      await registerDeviceKey({ participantId: participant.id, enrollmentProof: params.enrollmentProof, deviceLabel: `${Platform.OS} device` });
      setKeyState("✓ Device key registered");
    } catch (error) { setKeyState(error instanceof Error ? error.message : "Device key registration failed"); }
  };
  const submit = async (capture: { image: string; livenessImages: string[] }) => {
    if (!participant || !params.enrollmentProof || !consented) return; setBusy(true);
    try {
      const result = await enrollFace({ ...capture, participantId: participant.id, enrollmentProof: params.enrollmentProof,
        ...(params.docNumber ? { identityDocument: { country: "NG", idType: (params.docType ?? "BVN").toUpperCase() as "BVN" | "NIN", idNumber: params.docNumber } } : {}) });
      if (isFaceJobPending(result)) { const complete = await awaitFaceJob(result.jobId); await finish(complete.suggestedDisplayName); }
      else await finish();
    } catch (error) { Alert.alert("Enrollment failed", error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const capture = async () => { try { await submit(await captureFaceSequence(camera)); }
    catch (error) { Alert.alert("Capture failed", error instanceof Error ? error.message : String(error)); } };
  const confirmName = async () => {
    if (!participant || !displayName.trim()) return;
    try { await confirmDisplayName(participant.id, displayName.trim()); onward(); }
    catch (error) { Alert.alert("Could not confirm name", error instanceof Error ? error.message : String(error)); }
  };
  if (!participant || !params.enrollmentProof) return <Page eyebrow="ONBOARDING" title="Enrollment proof required"><Card><Text style={s.body}>The edge must return a short-lived enrollmentProof from verified onboarding. Restart KYC after that integration is enabled.</Text></Card></Page>;
  return (
    <Page eyebrow={`${role.toUpperCase()} · SIGN-IN`} title="Set up face sign-in">
      {!enrolled ? <Section title="Consent and seven-frame capture">
        <Text style={s.muted}>Consent biometric-capture-v2: fresh frames are used for Biometric KYC and your encrypted 1:1 embedding. After vendor approval, one current enrollment selfie is retained privately until replacement or account deletion; it is never shown publicly. Your legal name is stored separately from this editable display name.</Text>
        <Button title={consented ? "✓ Consent recorded for this capture" : "I consent to capture and vendor submission"} secondary onPress={() => setConsented(true)} />
        {!permission?.granted ? <Button title="Allow camera" onPress={requestPermission} /> : <>
          <View style={{ height: 240, overflow: "hidden", borderRadius: 18 }}><CameraView ref={camera} style={{ flex: 1 }} facing="front" /></View>
          <Button title={busy ? "Verifying…" : "Capture 7 frames and enroll"} onPress={() => { if (consented && !busy) void capture(); }} />
        </>}
      </Section> : <Section title="Confirm your display name">
        <Label>Vendor legal name may prefill this; your verified legal name will not change.</Label>
        <Field value={displayName} onChangeText={setDisplayName} />
        <Text style={s.muted}>{keyState}</Text>
        <Button title="Confirm name and continue" onPress={confirmName} />
      </Section>}
    </Page>
  );
}
