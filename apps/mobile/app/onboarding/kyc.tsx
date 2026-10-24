import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import { onboardParticipant, setActiveParticipant, setActiveMarket } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

const ONBOARDING_CONSENT_VERSION = "kyc-onboarding-v1";

/** Document-only KYC onboarding. Fresh biometric frames go directly to identity on the next step. */
export default function OnboardingKyc() {
  const params = useLocalSearchParams<{ role?: string; displayName?: string; market?: string }>();
  const role = (params.role ?? "buyer") as "buyer" | "seller" | "runner";
  const [docType, setDocType] = useState<"bvn" | "nin">("bvn");
  const [docNumber, setDocNumber] = useState("");
  const [email, setEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!/^\d{11}$/.test(docNumber)) {
      Alert.alert("Check your document", `${docType.toUpperCase()} is 11 digits.`);
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      Alert.alert("Check your email", "Enter a valid email for receipts and security notices.");
      return;
    }
    if (!consented) {
      Alert.alert("Consent required", "Consent to document verification before continuing.");
      return;
    }
    setBusy(true);
    try {
      const recorded = await onboardParticipant({
        role,
        displayName: params.displayName ?? "Trader",
        email: email.trim(),
        consentAt: Date.now(),
        consentVersion: ONBOARDING_CONSENT_VERSION,
        idDocumentType: docType,
        idDocument: docNumber,
        market: params.market ?? "Balogun",
      });
      const { participant, enrollmentProof } = recorded;
      if (participant.kycStatus === "pending") {
        Alert.alert("Verification pending", "Real identity verification is still pending. Face enrollment unlocks only after verification completes.");
        return;
      }
      if (participant.kycStatus !== "verified" && participant.kycStatus !== "preverified") {
        Alert.alert("Verification failed", "The document could not be verified. Check the number and try again.");
        return;
      }
      if (!enrollmentProof) throw new Error("The identity service did not return an enrollment proof. Please retry.");
      await setActiveParticipant(participant);
      await setActiveMarket(params.market ?? "Balogun");
      router.replace({ pathname: "/onboarding/face", params: { role: participant.role, enrollmentProof, docType, docNumber } });
    } catch (error) {
      Alert.alert("Could not verify", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`${role.toUpperCase()} · ${(params.market ?? "").toUpperCase()}`} title="Verify your identity">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>DOCUMENT CHECK · ALL ROLES</Pill>
        <Text style={{ color: "white", fontSize: 19, fontWeight: "800" }}>Hi {params.displayName ?? "there"} — one last step.</Text>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          Your document number is used in transit and only its keyed hash is stored. Face frames are captured on the next screen and sent directly to identity without public media storage.
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

      <Section title="Receipts and security notices">
        <Label>Email is never used for account recovery</Label>
        <Field value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="you@example.com" />
        <Pressable onPress={() => setConsented((value) => !value)}>
          <Card style={{ borderColor: consented ? colors.green : colors.line }}>
            <Text style={s.body}>{consented ? "✓ " : ""}I consent to verification of this document and storage of its keyed hash ({ONBOARDING_CONSENT_VERSION}).</Text>
          </Card>
        </Pressable>
      </Section>

      <Button title={busy ? "Verifying…" : "Verify and join"} onPress={submit} />
    </Page>
  );
}
