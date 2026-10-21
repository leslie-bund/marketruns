import { Image, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { HANDOFF_AUTO_CONFIRM_MS } from "@market-runs/domain";
import type { RunHandoff } from "@market-runs/proto";
import { captureUrl } from "../../api";
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
        source={{ uri: captureUrl(handoff.photoCaptureRef) }}
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
export function HandoffQrCard({ handoff, now, prompt }: { handoff: RunHandoff; now: number; prompt: string }) {
  if (handoff.status === "confirmed") {
    return (
      <Card>
        <View style={s.row}>
          <Text style={{ color: colors.ink, fontWeight: "800" }}>{prompt}</Text>
          <Pill active>{handoff.autoConfirmed ? "AUTO-CONFIRMED" : "CONFIRMED"}</Pill>
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
            ? "SCANNED · WAITING FOR RUNNER PHOTO"
            : `WAITING · AUTO-CONFIRM IN ${countdownClock(handoff.requestedAt + HANDOFF_AUTO_CONFIRM_MS, now)}`}
      </Pill>
      <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17, textAlign: "center" }}>{prompt}</Text>
      {handoff.scannedAt == null ? (
        <View style={{ padding: 14, backgroundColor: "white", borderRadius: 18 }}>
          <QRCode value={`market-runs:handoff:${handoff.id}`} size={200} />
        </View>
      ) : (
        <Text style={s.muted}>Challenge scanned — the handoff confirms when the runner's photo lands.</Text>
      )}
      <Text style={s.muted}>One-time challenge · {handoff.id}</Text>
      <HandoffPhoto handoff={handoff} />
    </Card>
  );
}
