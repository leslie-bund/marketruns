import { useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useLocalSearchParams } from "expo-router";
import {
  ApiError,
  attachPhoto,
  confirmHandoff,
  identities,
  newId,
  scanChallenge,
  uploadCapture,
  useActiveParticipant,
} from "../../src/api";
import { canRunnerMutate, HandoffPhoto, parseHandoffPayload } from "../../src/features/run";
import { useRunnerRun } from "../../src/features/runner";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

export default function HandoffScreen() {
  const { handoffId, runId } = useLocalSearchParams<{ handoffId: string; runId?: string }>();
  const run = useRunnerRun(2000, runId);
  const { participant } = useActiveParticipant();
  const runnerId = participant?.id ?? identities.runner.id;
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const camera = useRef<CameraView>(null);
  const handoff = run.run?.handoffs.find((candidate) => candidate.id === handoffId) ?? null;
  const delivery = handoff?.type === "delivery";
  const verified = handoff?.scannedAt != null;
  const freshPhoto = Boolean(handoff?.photoCaptureRef && verified && handoff.photoCapturedAt != null && handoff.photoCapturedAt >= (handoff.scannedAt ?? 0));

  const fail = (label: string) => (error: unknown) => Alert.alert(label, error instanceof Error ? error.message : String(error));
  const verify = async (challenge: string) => {
    if (!run.run || busy) return;
    setBusy(true);
    try {
      await scanChallenge(run.run.id, handoffId, challenge);
      setScanning(false);
      run.refresh();
      if (delivery) Alert.alert("Code verified", "Take a new photo now, then explicitly confirm the receiver's handoff.");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409 && error.code === "photo-required")) fail("Verification failed")(error);
      else { setScanning(false); run.refresh(); }
    } finally { setBusy(false); }
  };

  const onScan = ({ data }: { data: string }) => {
    if (!scanning || !run.run) return;
    const payload = parseHandoffPayload(data);
    if (!payload || payload.runId !== run.run.id || payload.handoffId !== handoffId) {
      Alert.alert("Wrong QR", "This is not the server-issued QR for the current handoff.");
      setScanning(false);
      return;
    }
    setScanning(false);
    void verify(payload.challenge);
  };

  const capturePhoto = async () => {
    const currentRunId = run.run?.id;
    if (!currentRunId || (delivery && !verified)) return;
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!picture?.uri) throw new Error("no picture returned");
      const upload = await uploadCapture(picture.uri, currentRunId);
      await attachPhoto(currentRunId, handoffId, upload.ref);
      run.refresh();
    } catch (error) {
      Alert.alert("Camera capture failed", error instanceof Error ? error.message : String(error), [
        { text: "Cancel", style: "cancel" },
        { text: "Use dev reference", onPress: () => {
          void attachPhoto(currentRunId, handoffId, `r2://archive/captures/${newId("capture")}.jpg`).then(run.refresh).catch(fail("Photo failed"));
        } },
      ]);
    }
  };

  const confirm = () => {
    if (!run.run) return;
    setBusy(true);
    void confirmHandoff(run.run.id, handoffId).then(() => { run.refresh(); Alert.alert("Receipt confirmed", "The delivery handoff is confirmed and its photo is now immutable."); })
      .catch(fail("Confirmation failed")).finally(() => setBusy(false));
  };

  if (run.run && !canRunnerMutate(run.run, runnerId)) {
    return <Page eyebrow="HANDOFF" title="Claim required"><Card><Text style={s.body}>Return to the runner pool and claim this Run before scanning, capturing evidence, or sharing location.</Text></Card></Page>;
  }
  if (handoff === null && run.run !== null) {
    return <Page eyebrow="HANDOFF" title="Handoff"><Card><Text style={s.body}>This handoff is unavailable or the run moved on.</Text></Card></Page>;
  }

  return (
    <Page eyebrow={delivery ? "DELIVERY RECEIPT" : "SELLER PICKUP"} title="Handoff">
      <Card>
        <Pill active={handoff?.status === "confirmed"}>{handoff?.status === "confirmed" ? `CONFIRMED · ${handoff.confirmedBy ?? "RECEIVER"}` : verified ? "CODE VERIFIED · FRESH PHOTO REQUIRED" : delivery ? "DELIVERY CODE REQUIRED" : "SIGNED QR REQUIRED"}</Pill>
        <Text style={{ color: colors.ink, fontSize: 19, fontWeight: "800" }}>{handoff?.counterparty ?? "…"}</Text>
        <Text style={s.body}>Exchange Point · {handoff?.exchangePoint}</Text>
        <Text style={s.muted}>{delivery ? "Ask the buyer or designated receiver for the 6-digit code. Code + a new photo + explicit confirmation are all required." : "Scan the seller's signed QR, then capture pickup evidence."}</Text>
      </Card>

      {delivery && !verified ? <Section title="Enter receiver's 6-digit code">
        <Label>Delivery code</Label>
        <Field value={code} onChangeText={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad" maxLength={6} placeholder="000000" />
        <Button title={busy ? "Verifying…" : "Verify delivery code"} onPress={() => code.length === 6 ? void verify(code) : Alert.alert("Enter all 6 digits")} />
      </Section> : null}

      {!verified ? <Section title="Or scan buyer/seller QR">
        {!permission ? <Text style={s.muted}>Checking camera permission…</Text> : !permission.granted ? <><Text style={s.body}>Camera access is used only for handoff QR scanning and evidence capture.</Text><Button title="Allow camera" onPress={requestPermission} /></> : (
          <View style={{ height: 240, overflow: "hidden", borderRadius: 18 }}><CameraView ref={camera} style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanning ? onScan : undefined} /></View>
        )}
      </Section> : null}

      {handoff?.status !== "confirmed" ? <Section title="Fresh photo evidence">
        {verified && permission?.granted ? <View style={{ height: 220, overflow: "hidden", borderRadius: 18 }}><CameraView ref={camera} style={{ flex: 1 }} /></View> : null}
        <Button title={freshPhoto ? "New evidence attached ✓" : delivery && !verified ? "Verify code before photo" : "Capture new evidence"} secondary={freshPhoto} onPress={capturePhoto} />
        {handoff ? <HandoffPhoto handoff={handoff} /> : null}
      </Section> : null}

      {delivery && verified && freshPhoto && handoff?.status === "pending" ? (
        run.run?.receiver?.kind === "designated" ? <Button title={busy ? "Confirming…" : "Confirm designated receiver received it"} onPress={confirm} /> : <Card><Text style={s.body}>The buyer must now tap “Confirm I received the delivery” in their Run view.</Text></Card>
      ) : null}
      {handoff?.status === "confirmed" ? <Pill active>Handoff complete · evidence locked</Pill> : null}
      {handoff?.status !== "confirmed" && verified ? <Button title="Scan / enter another code" secondary onPress={() => setScanning(true)} /> : null}
    </Page>
  );
}
