import { useState } from "react";
import { router } from "expo-router";
import { Alert, Text } from "react-native";
import { buyerIdForRun, finalDelivery, initiateHandoff, locationTick, identities, newId } from "../../src/api";
import { HandoffList, RunMap, StopList, TripSummaryCard, useRunnerRun, useRunnerLocationStream } from "../../src/features/run";
import { useActiveMarket, useActiveParticipant } from "../../src/api";
import { Button, Card, Page, Pill, Section, s } from "../../src/ui";

export default function RunnerHome() {
  // The device's stored run id wins; with none, discovery polls the live_runs
  // index so a runner device that never saw the checkout still finds its run.
  const run = useRunnerRun();
  const [busy, setBusy] = useState(false);
  const [gpsWanted, setGpsWanted] = useState(false);
  const market = useActiveMarket();
  const { participant } = useActiveParticipant();
  const current = run.run;
  const gps = useRunnerLocationStream(gpsWanted && current ? current.id : null);

  const act = (work: () => Promise<unknown>, label: string) => async () => {
    setBusy(true);
    try {
      await work();
      run.refresh();
    } catch (error) {
      Alert.alert(label, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (current === null) {
    return (
      <Page eyebrow={`INTERNAL RUNNER · ${market.toUpperCase()}`} title="Your Run">
        <Card>
          <Text style={s.body}>{run.error ? `Edge: ${run.error}` : "No active run — a run appears here the moment a buyer checks out."}</Text>
          <Text style={s.muted}>
            {participant ? `Running as ${participant.displayName} (${participant.id}).` : `This device is the internal runner pool (${identities.runner.id}).`}
          </Text>
        </Card>
      </Page>
    );
  }

  const nextStop = current.stops.find((stop) => stop.status !== "completed");
  const allCollected = current.stops.every((stop) => stop.status === "completed");
  const deliveryLabel = current.delivery.kind === "plus-code" ? current.delivery.plusCode : current.delivery.name;
  // The delivery handoff is the buyer's QR-challenge receipt: one per run,
  // addressed to the run's actual buyer (read from the edge-issued run id).
  const buyer = buyerIdForRun(current);
  const deliveryHandoff = buyer === null ? undefined : current.handoffs.find((handoff) => handoff.counterparty === buyer);
  const anyPending = current.handoffs.some((handoff) => handoff.status === "pending");

  return (
    <Page eyebrow={`INTERNAL RUNNER · ${current.market.toUpperCase()} · ${run.live ? "LIVE" : "POLLING"}`} title="Your Run">
      <RunMap run={current} />
      <TripSummaryCard run={current} />

      <Section title="Ordered stops">
        <StopList stops={current.stops} />
      </Section>

      <Section title="Handoffs">
        <HandoffList handoffs={current.handoffs} onOpen={(handoffId) => router.push({ pathname: "/runner/handoff", params: { handoffId } })} />
      </Section>

      <Section title="Final Exchange Point">
        <Card>
          <Text style={s.body}>
            {current.delivery.kind === "plus-code" ? `Buyer location · ${deliveryLabel}` : `Muster Point · ${deliveryLabel}`}
          </Text>
        </Card>
      </Section>

      {nextStop && !anyPending ? (
        <Button
          title={busy ? "Working…" : `Open Handoff at ${nextStop.sellerName}`}
          onPress={act(async () => {
            await initiateHandoff(current.id, {
              handoffId: newId("handoff"),
              exchangePointId: nextStop.exchangePoint,
              counterparty: nextStop.sellerName,
            });
          }, "Could not initiate handoff")}
        />
      ) : null}
      {allCollected && buyer !== null && !deliveryHandoff && current.status !== "delivered" ? (
        <Button
          title={busy ? "Working…" : "Open delivery handoff with the buyer"}
          onPress={act(async () => {
            await initiateHandoff(current.id, {
              handoffId: newId("handoff"),
              exchangePointId: deliveryLabel,
              counterparty: buyer,
            });
          }, "Could not initiate delivery handoff")}
        />
      ) : null}
      {deliveryHandoff?.status === "pending" ? (
        <Pill active>
          {deliveryHandoff.awaitingPhoto
            ? "Delivery handoff waiting on your photo evidence — no photo, no confirm"
            : `Delivery handoff open — scan the buyer's QR at ${deliveryLabel}, then photograph the exchange`}
        </Pill>
      ) : null}
      <Button
        title={gps.sharing ? "Live location ON — stop sharing" : "Share live location (GPS)"}
        secondary={gps.sharing}
        onPress={() => setGpsWanted((wanted) => !wanted)}
      />
      {gps.error ? <Text style={s.muted}>{gps.error}</Text> : null}
      {/* Simulators without a simulated location can still move the dot by hand. */}
      {!gps.sharing ? (
        <Button title="Location tick (dev)" secondary onPress={act(() => locationTick(current.id, 6.4541, 3.3947), "Location failed")} />
      ) : null}
      {allCollected && deliveryHandoff?.status === "confirmed" && current.status !== "delivered" ? (
        <Button title="Final delivery" onPress={act(() => finalDelivery(current.id), "Final delivery refused")} />
      ) : null}
    </Page>
  );
}
