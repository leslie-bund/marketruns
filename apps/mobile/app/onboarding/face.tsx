import { useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  AuthError,
  DEV_FACE_IMAGE_BASE64,
  awaitFaceJob,
  enrollFace,
  isFaceJobPending,
  registerDeviceKey,
  useActiveParticipant,
} from "../../src/api";
import { Button, Card, Page, Pill, Section, colors, s } from "../../src/ui";

/**
 * Onboarding step 4: enroll the sign-in face. KYC already verified the
 * participant; this selfie (camera-only, one frame, base64 jpeg) goes to the
 * identity worker's enroll seam. Right after enrolling, the device key is
 * registered silently in the background — the secret lives in SecureStore and
 * never leaves the device.
 */
export default function OnboardingFace() {
  const params = useLocalSearchParams<{ role?: string }>();
  const role = (params.role ?? "buyer") as "buyer" | "seller" | "runner";
  const { participant } = useActiveParticipant();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [capturing, setCapturing] = useState(false);
  // Async verifier mode (202 + job polling): honest "still verifying" state.
  const [verifying, setVerifying] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  // Background device-key registration: "pending" | "ok" | AuthError message.
  const [keyState, setKeyState] = useState<"idle" | "pending" | "ok" | "exists" | "failed">("idle");

  const onward = () => {
    // Sellers continue into store creation; buyers and runners go home.
    router.replace(role === "seller" ? "/seller/join" : `/${role}`);
  };

  /** Silent background step after enrollment — never blocks the flow. */
  const registerKeyInBackground = (participantId: string) => {
    setKeyState("pending");
    registerDeviceKey({ participantId, deviceLabel: `${Platform.OS} device` })
      .then(() => setKeyState("ok"))
      .catch((error: unknown) => {
        if (error instanceof AuthError && error.status === 409 && error.code === "credential-exists") {
          // Server has upsert disabled and this participant already has a
          // credential — surface it honestly and offer the reset path.
          setKeyState("exists");
        } else {
          setKeyState("failed");
        }
      });
  };

  const captureAndEnroll = async (image: string) => {
    if (!participant) return;
    setCapturing(true);
    try {
      const result = await enrollFace({ participantId: participant.id, role: participant.role, image });
      if (isFaceJobPending(result)) {
        // Async vendor-held mode: the enrollment lands when the verdict does.
        setVerifying(true);
        try {
          await awaitFaceJob(result.jobId);
        } finally {
          setVerifying(false);
        }
      }
      setEnrolled(true);
      registerKeyInBackground(participant.id);
    } catch (error) {
      Alert.alert("Enrollment failed", error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
    }
  };

  const captureFace = async () => {
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6, base64: true });
      if (!picture?.base64) throw new Error("no picture returned");
      await captureAndEnroll(picture.base64);
    } catch (error) {
      Alert.alert("Capture failed", error instanceof Error ? error.message : String(error));
    }
  };

  if (!participant) {
    return (
      <Page eyebrow="ONBOARDING" title="Set up sign-in">
        <Card>
          <Text style={s.body}>No verified participant on this device — start onboarding first.</Text>
        </Card>
        <Button title="Back to onboarding" onPress={() => router.replace("/onboarding")} />
      </Page>
    );
  }

  return (
    <Page eyebrow={`${role.toUpperCase()} · SIGN-IN`} title="Set up sign-in">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>FACE + THIS DEVICE</Pill>
        <Text style={{ color: "white", fontSize: 19, fontWeight: "800" }}>This is how you'll sign in — no passwords.</Text>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          One selfie enrolls your face. This device also gets its own key, stored in the secure enclave — it never leaves the phone.
        </Text>
      </Card>

      <Section title="Enroll your face">
        {enrolled ? (
          <Pill active>✓ FACE ENROLLED</Pill>
        ) : !permission?.granted ? (
          <>
            <Text style={s.muted}>Camera access is used only for this enrollment capture.</Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </>
        ) : (
          <>
            <View style={{ height: 240, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
              <CameraView ref={camera} style={{ flex: 1 }} facing="front" />
            </View>
            <Text style={s.muted}>Look straight at the camera, find good light, one frame is enough.</Text>
            <Button title={capturing ? (verifying ? "Verifying…" : "Enrolling…") : "Capture and enroll"} onPress={captureFace} />
            {verifying ? (
              <Text style={s.muted}>Still verifying with the provider — this usually takes a few seconds.</Text>
            ) : null}
            {/* Simulators and browsers have no camera — dev affordance only. */}
            <Button
              title="Use dev capture (simulator)"
              secondary
              onPress={() => void captureAndEnroll(DEV_FACE_IMAGE_BASE64)}
            />
          </>
        )}
      </Section>

      {keyState === "pending" ? <Text style={s.muted}>Registering this device's key in the background…</Text> : null}
      {keyState === "ok" ? <Pill active>✓ DEVICE KEY REGISTERED</Pill> : null}
      {keyState === "exists" ? (
        <Card style={{ borderColor: colors.orange }}>
          <Text style={s.body}>The server already holds a key for this participant and won't replace it.</Text>
          <Button
            title="Reset this device's access"
            secondary
            danger
            onPress={() => router.push("/device-reset")}
          />
        </Card>
      ) : null}
      {keyState === "failed" ? (
        <Text style={{ color: colors.orange, fontSize: 12 }}>
          The device key didn't register — you can still sign in with your face, and key sign-in retries on next launch.
        </Text>
      ) : null}

      {enrolled ? <Button title="Continue" onPress={onward} /> : null}
      {!enrolled ? (
        <Pressable onPress={onward} style={{ alignSelf: "center", paddingVertical: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 11, textDecorationLine: "underline" }}>Skip for now — sign-in will ask again</Text>
        </Pressable>
      ) : null}
    </Page>
  );
}
