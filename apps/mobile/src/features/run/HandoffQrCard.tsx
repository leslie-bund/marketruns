import { Image, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { HANDOFF_AUTO_CONFIRM_MS } from "@market-runs/domain";
import type { RunHandoff } from "@market-runs/proto";
import { captureUrl, participantHeaders, sessionHeaders } from "../../api";
import { createHandoffPayload } from "./handoff-payload";
import { Card, Pill, colors, s } from "../../ui";
import { countdownClock } from "./format";

/**
 * The runner's photo evidence at an exchange point, rendered from its signed
 * capture reference (ADR-0007). Shared by every role that watches a handoff:
 * the seller sees the pickup photo, the buyer sees pickup and delivery
 * photos — mismatch with reality is what a dispute is filed on.
 */
export function HandoffPhoto({ handoff, size = 96 }: { handoff: RunHandoff; size?: number }) {
  if (!handoff.photoCaptureRef) return null;
  return (
    <View style={{ gap: 6 }}>
      <Image
        source={{ uri: captureUrl(handoff.photoCaptureRef), headers: { ...sessionHeaders(), ...participantHeaders() } }}
        style={{ width: size, height: size, borderRadius: 14, backgroundColor: "#E5EBE3" }}
      />
      <Text style={s.muted}>
        Runner's photo · {handoff.exchangePoint}
        {handoff.photoCapturedAt != null ? ` · ${new Date(handoff.photoCapturedAt).toLocaleTimeString()}` : ""}
      </Text>
    </View>
  );
}

/**
 * The counterparty's side of a QR-challenge handoff: while pending, show the
 * one-time challenge the runner scans; once confirmed, a receipt row. The
 * runner's photo evidence renders inline the moment it lands on the wire —
 * the counterparty can compare it with what actually changed hands before
 * the auto-confirm / dispute windows close. Shared by the seller (pickup)
 * and the buyer (delivery receipt).
 */
export function HandoffQrCard({ handoff, runId, challenge, now, prompt }: { handoff: RunHandoff; runId: string; challenge?: string | undefined; now: number; prompt: string }) {
  if (handoff.status === "confirmed") {
    return (
      <Card>
        <View style={s.row}>
          <Text style={{ color: colors.ink, fontWeight: "800" }}>{prompt}</Text>
          <Pill active>{handoff.autoConfirmed ? "AUTO-CONFIRMED" : `CONFIRMED · ${handoff.confirmedBy ?? "RECEIVER"}`}</Pill>
        </View>
        <HandoffPhoto handoff={handoff} />
      </Card>
    );
  }
  return (
    <Card style={{ alignItems: "center", gap: 12 }}>
      <Pill active>
        {handoff.awaitingPhoto
          ? "WAITING FOR RUNNER PHOTO EVIDENCE"
          : handoff.scannedAt != null
            ? "CODE VERIFIED · FRESH PHOTO + CONFIRM REQUIRED"
            : handoff.type === "delivery" ? "DELIVERY CODE REQUIRED" : `WAITING · AUTO-CONFIRM IN ${countdownClock(handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS, now)}`}
      </Pill>
      <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17, textAlign: "center" }}>{prompt}</Text>
      {handoff.scannedAt == null && challenge ? (
        <View style={{ padding: 14, backgroundColor: "white", borderRadius: 18 }}>
          <QRCode value={createHandoffPayload({ runId, handoffId: handoff.id, challenge })} size={200} />
        </View>
      ) : handoff.scannedAt == null ? <Text style={s.muted}>Loading secure QR…</Text> : (
        <Text style={s.muted}>Code verified. The runner must take a new photo and explicitly confirm receipt.</Text>
      )}
      <HandoffPhoto handoff={handoff} />
    </Card>
  );
}
