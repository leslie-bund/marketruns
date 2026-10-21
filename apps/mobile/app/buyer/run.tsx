import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { DISPUTE_WINDOW_MS } from "@market-runs/domain";
import { ApiError, buyerIdForRun, fileDispute } from "../../src/api";
import { HandoffPhoto, HandoffQrCard, RunMap, StopList, TripSummaryCard, useRun } from "../../src/features/run";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

/** Preset dispute reasons — the optional detail field is appended when filled. */
const DISPUTE_REASONS = ["Items missing from the delivery", "Wrong items delivered", "Runner never arrived", "Delivery was damaged"];

/**
 * The buyer's live run tracking: the trip map, which stops remain, what the
 * trip is expected to take — and, when the runner arrives, the one-time QR
 * challenge that confirms receipt. Live updates arrive over the run's
 * WebSocket; polling is the fallback.
 */
export default function BuyerRun() {
  const run = useRun();
  const [now, setNow] = useState(Date.now());
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  /** The filed dispute's reason, once the edge has accepted it (200, or 409 = already filed). */
  const [filed, setFiled] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = run.run;
  const currentId = current?.id ?? null;

  // A different run (new checkout) starts with a clean dispute state.
  useEffect(() => {
    setFiled(null);
    setDetail("");
  }, [currentId]);

  if (current === null) {
    return (
      <Page eyebrow="YOUR RUN" title="Track your Run">
        <Card>
          <Text style={s.body}>{run.error ? `Edge: ${run.error}` : "No active run — check out a cart and it appears here."}</Text>
        </Card>
      </Page>
    );
  }

  // The delivery handoff belongs to the run's actual buyer, read from the
  // edge-issued run id — never a hardcoded identity.
  const buyer = buyerIdForRun(current);
  const myHandoffs = current.handoffs.filter((handoff) => handoff.counterparty === buyer);

  // The filed pill is durable: it derives from run.disputed on the wire, so
  // it survives an app restart (the session-local `filed` only gives instant
  // feedback before the next refresh lands).
  const disputeFiled = current.disputed === true || filed !== null;
  // The dispute-window countdown, computed honestly from the run's
  // final-delivery stamp (finalDeliveryAt + 30 min, then settlement releases).
  const disputeDeadline = current.finalDeliveryAt != null ? current.finalDeliveryAt + DISPUTE_WINDOW_MS : null;
  const disputeMinutesLeft = disputeDeadline === null ? null : Math.max(0, Math.ceil((disputeDeadline - now) / 60_000));

  const dispute = (preset: string) => {
    const reason = detail.trim() ? `${preset} — ${detail.trim()}` : preset;
    // Evidence-first (ADR-0007): the dispute carries every handoff photo ref
    // the wire already shows — the edge merges these server-side too.
    const evidenceRefs = current.handoffs
      .map((handoff) => handoff.photoCaptureRef)
      .filter((ref): ref is string => ref !== undefined);
    setBusy(true);
    fileDispute(current.id, reason, evidenceRefs)
      .then(() => setFiled(reason))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409) {
          // Already disputed (this device or another): the filed state still applies.
          setFiled(reason);
        } else {
          Alert.alert("Could not report the problem", error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => setBusy(false));
  };

  const report = () => {
    Alert.alert(
      "Report a problem",
      "What went wrong with this delivery? Filing pauses settlement while the evidence is reviewed.",
      [...DISPUTE_REASONS.map((reason) => ({ text: reason, onPress: () => dispute(reason) })), { text: "Cancel", style: "cancel" as const }],
    );
  };

  return (
    <Page eyebrow={`${current.market.toUpperCase()} · ${run.live ? "LIVE" : "POLLING"}`} title="Track your Run">
      <RunMap run={current} />
      <TripSummaryCard run={current} />

      <Section title="Stops">
        <StopList stops={current.stops} />
      </Section>

      <Section title="Delivery to you">
        <Card>
          <Text style={s.body}>
            {current.delivery.kind === "plus-code" ? `Your location · ${current.delivery.plusCode}` : `Muster Point · ${current.delivery.name}`}
          </Text>
        </Card>
        {myHandoffs.map((handoff) => (
          <HandoffQrCard
            key={handoff.id}
            handoff={handoff}
            now={now}
            prompt="Show this code to your runner to confirm you received everything"
          />
        ))}
      </Section>

      <Section title="Handoff evidence">
        <Card>
          <Text style={s.muted}>
            The runner photographs every exchange point — each seller pickup and your delivery. Check the photos
            match what you actually received; if they don't, report a problem below while the dispute window is open.
          </Text>
        </Card>
        {current.handoffs.length === 0 ? (
          <Card><Text style={s.muted}>No handoffs yet — photos land here as the runner collects your items.</Text></Card>
        ) : null}
        {current.handoffs.map((handoff) => (
          <Card key={handoff.id}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>
                  {handoff.counterparty === buyer ? "Delivery to you" : `Pickup · ${handoff.counterparty}`}
                </Text>
                <Text style={s.muted}>{handoff.exchangePoint}</Text>
              </View>
              <Pill active={handoff.status === "confirmed"}>
                {handoff.status === "confirmed"
                  ? handoff.autoConfirmed
                    ? "AUTO-CONFIRMED"
                    : "CONFIRMED"
                  : handoff.awaitingPhoto
                    ? "AWAITING PHOTO"
                    : "PENDING"}
              </Pill>
            </View>
            {handoff.photoCaptureRef ? (
              <HandoffPhoto handoff={handoff} size={120} />
            ) : (
              <Text style={s.muted}>
                {/* Confirms are never photoless (photo-required confirm): a
                    photoless handoff is always still awaiting evidence. */}
                {handoff.awaitingPhoto
                  ? "Awaiting photo evidence — auto-confirm is paused until the runner's photo lands."
                  : handoff.status === "pending"
                    ? "Photo lands here the moment the runner captures it — the handoff confirms with the photo."
                    : "No photo on record — mention it if you report a problem."}
              </Text>
            )}
          </Card>
        ))}
      </Section>

      {current.status === "delivered" ? (
        <Section title="Dispute window">
          <Card>
            <Pill active>
              {disputeMinutesLeft === null
                ? "Delivered — a 30-minute dispute window is open, then settlement releases"
                : `Delivered — dispute window open · ${disputeMinutesLeft} min left, then settlement releases`}
            </Pill>
            {disputeFiled ? (
              <View style={{ backgroundColor: "#FBEEE3", borderRadius: 99, paddingHorizontal: 11, paddingVertical: 6, alignSelf: "flex-start" }}>
                <Text style={{ color: colors.orange, fontSize: 11, fontWeight: "700" }}>DISPUTE FILED — SETTLEMENT PAUSED PENDING REVIEW</Text>
              </View>
            ) : (
              <>
                <Label>Anything wrong? Add detail (optional)</Label>
                <Field value={detail} onChangeText={setDetail} placeholder="e.g. one bag was not mine" />
                <Button title={busy ? "Reporting…" : "Report a problem"} secondary danger onPress={report} />
              </>
            )}
          </Card>
        </Section>
      ) : null}
      {current.status === "closed" ? <Pill active>Run closed — settlement released</Pill> : null}
    </Page>
  );
}
