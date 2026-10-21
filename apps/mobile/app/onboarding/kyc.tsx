import { useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Image, Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { onboardParticipant, setActiveParticipant, setActiveMarket, uploadCapture } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

/**
 * Onboarding step 3: identity verification (ADR-0004 — universal KYC, buyers
 * included). BVN or NIN plus a facial capture; the edge verifies through the
 * vendor-neutral verifier seam (ADR-0009) and stores only the document hash.
 * Camera-only capture doctrine applies — no media library.
 */
export default function OnboardingKyc() {
  const params = useLocalSearchParams<{ role?: string; displayName?: string; market?: string }>();
  const role = (params.role ?? "buyer") as "buyer" | "seller" | "runner";
  const [docType, setDocType] = useState<"bvn" | "nin">("bvn");
  const [docNumber, setDocNumber] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [face, setFace] = useState<{ ref: string; url: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);

  const captureFace = async () => {
    setCapturing(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!picture?.uri) throw new Error("no picture returned");
      setFace(await uploadCapture(picture.uri));
    } catch (error) {
      Alert.alert("Capture failed", error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
    }
  };

  const submit = async () => {
    if (!/^\d{11}$/.test(docNumber)) {
      Alert.alert("Check your document", `${docType.toUpperCase()} is 11 digits.`);
      return;
    }
    if (!face) {
      Alert.alert("Facial capture required", "Verification needs a live facial capture.");
      return;
    }
    setBusy(true);
    try {
      const participant = await onboardParticipant({
        role,
        displayName: params.displayName ?? "Trader",
        idDocumentType: docType,
        idDocument: docNumber,
        facialCaptureRef: face.ref,
        market: params.market ?? "Balogun",
      });
      if (participant.kycStatus !== "verified") {
        Alert.alert("Verification failed", "The document could not be verified. Check the number and try again.");
        return;
      }
      await setActiveParticipant(participant);
      await setActiveMarket(params.market ?? "Balogun");
      // KYC passed → step 4 enrolls the sign-in face (and registers this
      // device's key in the background). That screen owns the onward route.
      router.replace({ pathname: "/onboarding/face", params: { role } });
    } catch (error) {
      Alert.alert("Could not verify", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`${role.toUpperCase()} · ${(params.market ?? "").toUpperCase()}`} title="Verify your identity">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>BVN-BACKED · ALL ROLES</Pill>
        <Text style={{ color: "white", fontSize: 19, fontWeight: "800" }}>Hi {params.displayName ?? "there"} — one last step.</Text>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          Your document number is verified and hashed; the raw number is never stored. The facial capture is camera-only.
        </Text>
      </Card>

      <Section title="Identity document">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable onPress={() => setDocType("bvn")} style={{ flex: 1 }}>
            <Card style={{ borderColor: docType === "bvn" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800", textAlign: "center" }}>BVN</Text>
            </Card>
          </Pressable>
          <Pressable onPress={() => setDocType("nin")} style={{ flex: 1 }}>
            <Card style={{ borderColor: docType === "nin" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800", textAlign: "center" }}>NIN</Text>
            </Card>
          </Pressable>
        </View>
        <Label>{docType.toUpperCase()} · 11 digits</Label>
        <Field value={docNumber} onChangeText={setDocNumber} keyboardType="number-pad" maxLength={11} placeholder="12345678901" />
      </Section>

      <Section title="Facial capture">
        {face ? (
          <>
            {face.url ? (
              <View style={{ height: 200, overflow: "hidden", borderRadius: 18 }}>
                <Image source={{ uri: face.url }} style={{ flex: 1 }} resizeMode="cover" />
              </View>
            ) : (
              <Pill active>DEV CAPTURE ATTACHED</Pill>
            )}
            <Button title="Retake" secondary onPress={() => setFace(null)} />
          </>
        ) : !permission?.granted ? (
          <>
            <Text style={s.muted}>Camera access is used only for the verification capture.</Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </>
        ) : (
          <>
            <View style={{ height: 200, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
              <CameraView ref={camera} style={{ flex: 1 }} facing="front" />
            </View>
            <Button title={capturing ? "Capturing…" : "Capture my face"} onPress={captureFace} />
            {/* Simulators and browsers have no camera — dev affordance only. */}
            <Button
              title="Use dev capture (simulator)"
              secondary
              onPress={() => setFace({ ref: "r2://archive/captures/dev-face.jpg", url: "" })}
            />
          </>
        )}
      </Section>

      <Button title={busy ? "Verifying…" : "Verify and join"} onPress={submit} />
    </Page>
  );
}
