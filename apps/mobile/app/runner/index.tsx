import { useState } from "react";
import { router } from "expo-router";
import { Alert, Text } from "react-native";
import { buyerIdForRun, claimRun, finalDelivery, getDeviceLocationFix, initiateHandoff, locationTick, identities, newId } from "../../src/api";
import { canRunnerMutate, HandoffList, RunMap, StopList, TripSummaryCard, useRunnerLocationStream, useRunnerPool } from "../../src/features/run";
import { useActiveMarket, useActiveParticipant } from "../../src/api";
import { Button, Card, Page, Pill, Section, s } from "../../src/ui";

export default function RunnerHome() {
  const run = useRunnerPool();
  const [busy, setBusy] = useState(false);
  const [gpsWanted, setGpsWanted] = useState(false);
  const market = useActiveMarket();
  const { participant } = useActiveParticipant();
  const runnerId = participant?.id ?? identities.runner.id;
  const current = run.run;
  const claimed = current ? canRunnerMutate(current, runnerId) : false;
  const gps = useRunnerLocationStream(gpsWanted && claimed && current ? current.id : null);

  const act = (work: () => Promise<unknown>, label: string) => async () => {
    setBusy(true);
    try {
      await work();
      run.refresh();
      run.refreshDiscovery();
    } catch (error) {
      Alert.alert(label, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const queue = (
    <>
      <Section title="Available to claim">
        {run.available.map((entry) => (
          <Card key={entry.runId}>
            <Pill active>UNASSIGNED</Pill>
            <Text style={s.body}>{entry.stopCount} stop(s) · started {new Date(entry.startedAt).toLocaleTimeString()}</Text>
            <Button
              title={busy ? "Claiming…" : "Claim this Run"}
              onPress={act(async () => {
                const location = await getDeviceLocationFix();
                await claimRun(entry.runId, location);
                run.selectRun(entry.runId);
              }, "Could not claim Run")}
            />
          </Card>
        ))}
        {run.available.length === 0 ? <Card><Text style={s.muted}>No unassigned runs in this market.</Text></Card> : null}
      </Section>
      <Section title="Claimed by you">
        {run.claimed.map((entry) => (
          <Card key={entry.runId}>
            <Pill active>{entry.status.toUpperCase()}</Pill>
            <Text style={s.body}>{entry.stopCount} stop(s) · {entry.runId}</Text>
            {current?.id !== entry.runId ? <Button title="Open claimed Run" secondary onPress={() => run.selectRun(entry.runId)} /> : null}
          </Card>
        ))}
        {run.claimed.length === 0 ? <Card><Text style={s.muted}>You have no claimed runs.</Text></Card> : null}
      </Section>
    </>
  );

  if (current === null) {
    return (
      <Page eyebrow={`INTERNAL RUNNER · ${market.toUpperCase()}`} title="Runner pool">
        {run.discoveryError || run.warning ? <Card><Text style={s.body}>{run.discoveryError ?? run.warning}</Text><Button title="Retry" onPress={run.refreshDiscovery} /></Card> : null}
        <Card>
          <Text style={s.muted}>{participant ? `Running as ${participant.displayName} (${participant.id}).` : `Demo internal runner (${identities.runner.id}).`}</Text>
        </Card>
        {queue}
      </Page>
    );
  }

  if (!claimed) {
    return <Page eyebrow="INTERNAL RUNNER" title="Claim required"><Card><Text style={s.body}>This Run is unassigned or belongs to another runner. Claim it before handoffs, location, or delivery.</Text></Card>{queue}</Page>;
  }

  const nextStop = current.stops.find((stop) => stop.status !== "completed");
  const allCollected = current.stops.every((stop) => stop.status === "completed");
  const deliveryLabel = current.delivery.kind === "plus-code" ? current.delivery.plusCode : current.delivery.name;
  const buyer = buyerIdForRun(current);
  const deliveryHandoff = buyer === null ? undefined : current.handoffs.find((handoff) => handoff.counterparty === buyer);
  const anyPending = current.handoffs.some((handoff) => handoff.status === "pending");

  return (
    <Page eyebrow={`CLAIMED · ${current.market.toUpperCase()} · ${run.live ? "LIVE" : "POLLING"}`} title="Your Run">
      {run.discoveryError || run.warning ? <Card><Text style={s.muted}>{run.discoveryError ?? run.warning}</Text></Card> : null}
      <RunMap run={current} />
      <TripSummaryCard run={current} />
      <Section title="Ordered stops"><StopList stops={current.stops} /></Section>
      <Section title="Handoffs">
        <HandoffList handoffs={current.handoffs} onOpen={(handoffId) => router.push({ pathname: "/runner/handoff", params: { handoffId, runId: current.id } })} />
      </Section>
      <Section title="Final Exchange Point">
        <Card><Text style={s.body}>{current.delivery.kind === "plus-code" ? `Buyer location · ${deliveryLabel}` : `Muster Point · ${deliveryLabel}`}</Text></Card>
      </Section>
      {nextStop && !anyPending ? (
        <Button title={busy ? "Working…" : `Open Handoff at ${nextStop.sellerName}`} onPress={act(() => initiateHandoff(current.id, {
          handoffId: newId("handoff"), exchangePointId: nextStop.exchangePoint, counterparty: nextStop.sellerName,
        }), "Could not initiate handoff")} />
      ) : null}
      {allCollected && buyer !== null && !deliveryHandoff && current.status !== "delivered" ? (
        <Button title={busy ? "Working…" : "Open delivery handoff with the buyer"} onPress={act(() => initiateHandoff(current.id, {
          handoffId: newId("handoff"), exchangePointId: deliveryLabel, counterparty: buyer,
        }), "Could not initiate delivery handoff")} />
      ) : null}
      {deliveryHandoff?.status === "pending" ? (
        <Pill active>{deliveryHandoff.awaitingPhoto ? "Delivery handoff waiting on your photo evidence — no photo, no confirm" : `Delivery handoff open — scan the buyer's QR at ${deliveryLabel}, then photograph the exchange`}</Pill>
      ) : null}
      <Button title={gps.sharing ? "Live location ON — stop sharing" : "Share live location (GPS)"} secondary={gps.sharing} onPress={() => setGpsWanted((wanted) => !wanted)} />
      {gps.error ? <Text style={s.muted}>{gps.error}</Text> : null}
      {!gps.sharing ? <Button title="Location tick (dev)" secondary onPress={act(() => locationTick(current.id, 6.4541, 3.3947), "Location failed")} /> : null}
      {allCollected && deliveryHandoff?.status === "confirmed" && current.status !== "delivered" ? <Button title="Final delivery" onPress={act(() => finalDelivery(current.id), "Final delivery refused")} /> : null}
      {queue}
    </Page>
  );
}
