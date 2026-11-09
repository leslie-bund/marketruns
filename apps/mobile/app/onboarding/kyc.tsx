import { useEffect, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import { onboardParticipant, setActiveParticipant, setActiveMarket, useActiveParticipant } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

const ONBOARDING_CONSENT_VERSION = "kyc-onboarding-v1";
const KYC_RETRY_INTERVAL_MS = 5_000;

/** Document-only KYC onboarding. Fresh biometric frames go directly to identity on the next step. */
export default function OnboardingKyc() {
  const params = useLocalSearchParams<{ role?: string; displayName?: string; market?: string }>();
  const role = (params.role ?? "buyer") as "buyer" | "seller" | "runner";
  const { participant: cached } = useActiveParticipant();
  const pending = cached?.role === role && cached.kycStatus === "pending" ? cached : null;
  const [docType, setDocType] = useState<"bvn" | "nin">(pending?.idDocumentType ?? "bvn");
  const [docNumber, setDocNumber] = useState("");
  const [email, setEmail] = useState(pending?.email ?? "");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(pending ? "Verification is still pending." : null);
  const retrying = useRef(false);
  const resumeRef = useRef<(silent?: boolean) => Promise<void>>(async () => undefined);

  const resume = async (silent = false) => {
    if (retrying.current) return;
    if (!/^\d{11}$/.test(docNumber)) {
      if (!silent) Alert.alert("Check your document", `${docType.toUpperCase()} is 11 digits.`);
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      if (!silent) Alert.alert("Check your email", "Enter a valid email for receipts and security notices.");
      return;
    }
    if (!consented) {
      if (!silent) Alert.alert("Consent required", "Consent to document verification before continuing.");
      return;
    }
    retrying.current = true;
    if (!silent) setBusy(true);
    try {
      const recorded = await onboardParticipant({
        role,
        displayName: pending?.displayName ?? params.displayName ?? "Trader",
        email: email.trim(),
        consentAt: Date.now(),
        consentVersion: ONBOARDING_CONSENT_VERSION,
        idDocumentType: docType,
        idDocument: docNumber,
        market: pending?.markets[0] ?? params.market ?? "Balogun",
        ...(pending ? { participantId: pending.id } : {}),
      });
      const { participant, enrollmentProof } = recorded;
      // Pending is durable device state too: retries and relaunches reuse this id.
      await setActiveParticipant(participant);
      if (participant.kycStatus === "pending") {
        setStatus("Verification is still pending. We’ll retry automatically; face enrollment stays locked until approval.");
        return;
      }
      if (participant.kycStatus !== "verified" && participant.kycStatus !== "preverified") {
        setStatus("The document could not be verified. Check the number and contact support before trying again.");
        return;
      }
      if (!enrollmentProof) throw new Error("The identity service did not return an enrollment proof. Please retry.");
      await setActiveMarket(participant.markets[0] ?? params.market ?? "Balogun");
      router.replace({ pathname: "/onboarding/face", params: { role: participant.role, enrollmentProof, docType, docNumber } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (silent) setStatus(`Could not refresh verification: ${message}`);
      else Alert.alert("Could not verify", message);
    } finally {
      retrying.current = false;
      if (!silent) setBusy(false);
    }
  };
  resumeRef.current = resume;

  useEffect(() => {
    if (!pending) return;
    setDocType(pending.idDocumentType);
    setEmail((current) => current || pending.email || "");
    setStatus("Verification is still pending. Re-enter the same document to resume; retries reuse your saved participant.");
  }, [pending?.id]);

  useEffect(() => {
    if (!pending || !consented || !/^\d{11}$/.test(docNumber)) return;
    const timer = setInterval(() => { void resumeRef.current(true); }, KYC_RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending?.id, docNumber, consented]);

  return (
    <Page eyebrow={`${role.toUpperCase()} · ${(pending?.markets[0] ?? params.market ?? "").toUpperCase()}`} title="Verify your identity">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>BVN / NIN VERIFICATION</Pill>
        <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>
          Your document number is used in transit and only its keyed hash is stored. Face frames are captured on the next screen and sent directly to identity without public media storage.
        </Text>
      </Card>

      {pending || status ? <Card style={{ borderColor: pending ? colors.orange : colors.line }}>
        <Pill active={pending !== null}>{pending ? "VERIFICATION PENDING" : "VERIFICATION UPDATE"}</Pill>
        <Text style={s.body}>{status}</Text>
        {pending ? <Text style={s.muted}>Participant {pending.id} is reused on every retry.</Text> : null}
      </Card> : null}

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

      <Button title={busy ? "Verifying…" : pending ? "Retry verification" : "Verify and join"} onPress={() => { void resume(); }} />
    </Page>
  );
}
