import { useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { HANDOFF_AUTO_CONFIRM_MS } from "@market-runs/domain";
import { useLocalSearchParams } from "expo-router";
import { ApiError, attachPhoto, identities, scanChallenge, newId, uploadCapture, useActiveParticipant } from "../../src/api";
import { canRunnerMutate, HandoffPhoto, useRunnerLocationStream } from "../../src/features/run";
import { useRunnerRun } from "../../src/features/runner";
import { Button, Card, Page, Pill, Section, colors, s } from "../../src/ui";

/**
 * One exchange point: the runner scans the seller's one-time QR challenge,
 * then captures photo evidence — the PHOTO is what confirms the handoff
 * (photo-required confirm; a scan alone never confirms). If the buyer stays
 * silent for 3 minutes AND the photo is attached, the server auto-confirms
 * (buyer silence = consent) — this screen reflects whatever the server says
 * on its next poll.
 */
export default function HandoffScreen() {
  const { handoffId, runId } = useLocalSearchParams<{ handoffId: string; runId?: string }>();
  const run = useRunnerRun(2000, runId);
  const { participant } = useActiveParticipant();
  const runnerId = participant?.id ?? identities.runner.id;
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [now, setNow] = useState(Date.now());
  const camera = useRef<CameraView>(null);
  const gps = useRunnerLocationStream(run.run?.id ?? null);

  const handoff = run.run?.handoffs.find((candidate) => candidate.id === handoffId) ?? null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = handoff ? Math.max(0, Math.ceil((handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS - now) / 1000)) : 0;
  // Evidence state is wire-driven: a refresh (or WS event) showing the photo
  // ref counts even if this device didn't attach it.
  const evidenceAttached = photo || handoff?.photoCaptureRef !== undefined && handoff?.photoCaptureRef !== null;

  const fail = (label: string) => (error: unknown) =>
    Alert.alert(label, error instanceof Error ? error.message : String(error));

  /**
   * Photo evidence: real camera capture → capture endpoint → the RunDO stores
   * the signed reference. The photo IS the confirm act: attaching it to a
   * scanned handoff confirms the handoff server-side. Simulators have no
   * camera, so a dev reference is offered explicitly when capture is
   * impossible.
   */
  const capturePhoto = async () => {
    const runId = run.run?.id;
    if (!runId) return;
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!picture?.uri) throw new Error("no picture returned");
      const upload = await uploadCapture(picture.uri);
      await attachPhoto(runId, handoffId, upload.ref);
      setPhoto(true);
      run.refresh();
    } catch (error) {
      Alert.alert("Camera capture failed", error instanceof Error ? error.message : String(error), [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use dev reference",
          onPress: () => {
            attachPhoto(runId, handoffId, `r2://archive/captures/${newId("capture")}.jpg`)
              .then(() => {
                setPhoto(true);
                run.refresh();
              })
              .catch(fail("Photo failed"));
          },
        },
      ]);
    }
  };

  const onScan = ({ data }: { data: string }) => {
    const runId = run.run?.id;
    if (scanned || !runId || !data.startsWith("market-runs:handoff:")) return;
    setScanned(true);
    scanChallenge(runId, handoffId)
      .then(() => {
        // 200 = the photo was already attached, so the scan confirmed.
        run.refresh();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409) {
          // Expected: photo-required. The scan is recorded; the photo is now
          // the blocking step — the handoff confirms when the capture lands.
          run.refresh();
          if (!evidenceAttached) {
            Alert.alert("Photo required to complete handoff", "Scan recorded. Capture photo evidence of what changed hands — the handoff confirms when the photo lands.", [
              { text: "Later", style: "cancel" },
              { text: "Capture now", onPress: () => void capturePhoto() },
            ]);
          }
        } else {
          fail("Scan failed")(error);
        }
      });
  };

  if (run.run && !canRunnerMutate(run.run, runnerId)) {
    return (
      <Page eyebrow="HANDOFF" title="Claim required">
        <Card><Text style={s.body}>Return to the runner pool and claim this Run before scanning, capturing evidence, or sharing location.</Text></Card>
      </Page>
    );
  }

  if (handoff === null && run.run !== null) {
    return (
      <Page eyebrow="HANDOFF" title="Handoff">
        <Card><Text style={s.body}>This handoff is closed — it confirmed or the run moved on.</Text></Card>
      </Page>
    );
  }

  return (
    <Page eyebrow="EXCHANGE POINT" title="Handoff">
      {gps.error ? <Card><Text style={s.body}>{gps.error}</Text></Card> : null}
      {!gps.sharing && !gps.error ? <Card><Text style={s.muted}>Acquiring fresh GPS for pickup or delivery confirmation…</Text></Card> : null}
      <Card>
        <Pill active={handoff?.status === "confirmed"}
        >
          {handoff?.status === "confirmed"
            ? "CONFIRMED"
            : handoff?.awaitingPhoto
              ? "AWAITING PHOTO EVIDENCE"
              : handoff?.scannedAt != null && !evidenceAttached
                ? "SCANNED · PHOTO REQUIRED TO CONFIRM"
                : `PENDING · AUTO-CONFIRM IN ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} (PHOTO REQUIRED)`}
        </Pill>
        <Text style={{ color: colors.ink, fontSize: 19, fontWeight: "800" }}>{handoff?.counterparty ?? "…"}</Text>
        <Text style={s.body}>Exchange Point · {handoff?.exchangePoint}</Text>
        <Text style={s.muted}>Scan the Seller's one-time QR challenge, then capture photo evidence — the photo completes the handoff. No photo, no confirm.</Text>
      </Card>

      <Section title="Scan QR challenge">
        {!permission ? (
          <Text style={s.muted}>Checking camera permission…</Text>
        ) : !permission.granted ? (
          <>
            <Text style={s.body}>Camera access is used only for Handoff QR scanning and evidence capture.</Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </>
        ) : (
          <View style={{ height: 240, overflow: "hidden", borderRadius: 18 }}>
            <CameraView
              ref={camera}
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={scanned ? undefined : onScan}
            />
          </View>
        )}
        {/* Dev affordance for simulators and browsers without a camera. */}
        <Button
          title="Simulate scan (dev)"
          secondary
          onPress={() => onScan({ data: `market-runs:handoff:${handoffId}` })}
        />
      </Section>

      <Section title="Photo evidence">
        <Button
          title={evidenceAttached ? "Evidence attached ✓" : "Capture evidence — required to confirm"}
          secondary={evidenceAttached}
          onPress={capturePhoto}
        />
        {handoff ? <HandoffPhoto handoff={handoff} /> : null}
      </Section>

      {handoff?.status === "confirmed" ? <Pill active>Stop completed — head to the next exchange point</Pill> : null}
    </Page>
  );
}
