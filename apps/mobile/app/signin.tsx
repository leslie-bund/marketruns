import { useRef, useState } from "react";
import { router } from "expo-router";
import { Alert, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  AuthError,
  DEV_FACE_IMAGE_BASE64,
  authenticateDeviceKey,
  awaitFaceJob,
  isFaceJobPending,
  useActiveParticipant,
  useDeviceCredential,
  verifyFace,
} from "../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

/** Banded mismatch copy: the server sends a similarityBucket, never a raw score. */
function mismatchCopy(bucket: unknown): string {
  const band = typeof bucket === "string" && bucket.length > 0 ? ` (match band: ${bucket})` : "";
  return `Not a close enough match${band} — try again in better light, looking straight at the camera.`;
}

/**
 * Sign in with face: one camera frame → /auth/face/verify → the returned
 * session token is cached and rides every request as Bearer from here on.
 * Failures are surfaced honestly: 401 face-mismatch shows the banded result,
 * 404 face-not-enrolled points at the device key or a device reset.
 */
export default function SignIn() {
  const { participant } = useActiveParticipant();
  const { credential } = useDeviceCredential();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  // Async verifier mode (202 + job polling): honest "still verifying" state.
  const [verifying, setVerifying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notEnrolled, setNotEnrolled] = useState(false);

  const hasDeviceKey = participant !== null && credential?.participantId === participant.id;

  const submit = async (image: string) => {
    if (!participant) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await verifyFace({ participantId: participant.id, image });
      if (isFaceJobPending(result)) {
        // Async vendor-held mode: the session is issued at job collection
        // (awaitFaceJob caches it). A failed job throws 401 face-mismatch,
        // exactly like the sync path.
        setVerifying(true);
        try {
          await awaitFaceJob(result.jobId);
        } finally {
          setVerifying(false);
        }
      }
      router.replace("/");
    } catch (error) {
      if (error instanceof AuthError && error.status === 401 && error.code === "face-mismatch") {
        setProblem(mismatchCopy(error.details.similarityBucket));
      } else if (error instanceof AuthError && error.status === 404 && error.code === "face-not-enrolled") {
        setNotEnrolled(true);
        setProblem("No face is enrolled for this participant — use this device's key or request a device reset.");
      } else if (error instanceof AuthError && error.code === "face-job-timeout") {
        setProblem(error.message);
      } else {
        Alert.alert("Sign-in failed", error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const captureFace = async () => {
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6, base64: true });
      if (!picture?.base64) throw new Error("no picture returned");
      await submit(picture.base64);
    } catch (error) {
      Alert.alert("Capture failed", error instanceof Error ? error.message : String(error));
    }
  };

  const deviceKeySignIn = async () => {
    if (!participant) return;
    setBusy(true);
    try {
      await authenticateDeviceKey(participant.id);
      router.replace("/");
    } catch (error) {
      Alert.alert("Device key failed", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!participant) {
    return (
      <Page eyebrow="SIGN IN" title="Welcome back">
        <Card>
          <Text style={s.body}>No onboarded participant on this device — onboard first, or explore the demo from the home screen.</Text>
        </Card>
        <Button title="Back" secondary onPress={() => router.replace("/")} />
      </Page>
    );
  }

  return (
    <Page eyebrow="SIGN IN" title={`Welcome back, ${participant.displayName}`}>
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>NO PASSWORDS</Pill>
        <Text style={{ color: "white", fontSize: 19, fontWeight: "800" }}>One look signs you in.</Text>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          Look straight at the camera, find good light. Your session attaches to every request once verified.
        </Text>
      </Card>

      {problem ? (
        <Card style={{ borderColor: colors.orange }}>
          <Text style={s.body}>{problem}</Text>
        </Card>
      ) : null}

      <Section title="Face sign-in">
        {!permission?.granted ? (
          <>
            <Text style={s.muted}>Camera access is used only for the sign-in capture.</Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </>
        ) : (
          <>
            <View style={{ height: 240, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
              <CameraView ref={camera} style={{ flex: 1 }} facing="front" />
            </View>
            <Button title={busy ? "Verifying…" : "Verify my face"} onPress={captureFace} />
            {verifying ? (
              <Text style={s.muted}>Still verifying with the provider — hold on, this usually takes a few seconds.</Text>
            ) : null}
            {/* Simulators and browsers have no camera — dev affordance only. */}
            <Button title="Use dev capture (simulator)" secondary onPress={() => void submit(DEV_FACE_IMAGE_BASE64)} />
          </>
        )}
      </Section>

      {hasDeviceKey || notEnrolled ? (
        <Button
          title={busy ? "Signing in…" : "Use this device's key instead"}
          secondary
          onPress={deviceKeySignIn}
        />
      ) : null}

      <Button title="Lost access? Request a device reset" secondary danger onPress={() => router.push("/device-reset")} />
      <Button title="Back" secondary onPress={() => router.replace("/")} />
    </Page>
  );
}
