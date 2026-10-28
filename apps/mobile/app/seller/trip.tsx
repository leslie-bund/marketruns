import { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { getHandoffChallenge, useActiveStore } from "../../src/api";
import type { RunHandoff } from "@market-runs/proto";
import { HandoffQrCard, RunMap, StopList, TripSummaryCard, useSellerRun } from "../../src/features/run";
import { Button, Card, Page, Section, s } from "../../src/ui";

function SellerPickupQr({ runId, handoff, now }: { runId: string; handoff: RunHandoff; now: number }) {
  const [challenge, setChallenge] = useState<string>();
  useEffect(() => {
    setChallenge(undefined);
    void getHandoffChallenge(runId, handoff.id).then(setChallenge).catch(() => setChallenge(undefined));
  }, [runId, handoff.id]);
  return <HandoffQrCard handoff={handoff} runId={runId} challenge={challenge} now={now} prompt="Show this signed QR when the runner arrives" />;
}

/**
 * The seller's trip view: the live run through this store's lens. Opened from
 * a specific product it drills into that product's stop (exchangePoint
 * param); opened from the home card it covers every stop at this store's
 * exchange point. The pending handoff shows the one-time QR the runner scans.
 */
export default function SellerTrip() {
  const { exchangePoint, runId } = useLocalSearchParams<{ exchangePoint?: string; runId?: string }>();
  const { store } = useActiveStore();
  const run = useSellerRun(store, 15000, runId);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = run.run;
  // Drill-down from a product scopes to that stop; otherwise the store's stall.
  const scope = exchangePoint ?? store?.exchangePoint ?? "";

  if (current === null) {
    return (
      <Page eyebrow="YOUR STORE · TRIP" title="Trip">
        <Card>
          <Text style={s.body}>{run.error ? `Could not load this trip: ${run.error}` : "No active run — trips appear here once a buyer checks out with your products."}</Text>
          {run.error ? <Button title="Retry" onPress={run.refresh} /> : null}
        </Card>
      </Page>
    );
  }

  const stops = current.stops.filter((stop) => stop.exchangePoint === scope);
  const handoffs = current.handoffs.filter((handoff) => handoff.exchangePoint === scope);

  return (
    <Page eyebrow={`${scope.toUpperCase()} · ${run.live ? "LIVE" : "POLLING"}`} title="Trip">
      {run.runs.length > 1 ? <Section title="Active trips">{run.runs.map((entry) => <Button key={entry.runId} title={current.id === entry.runId ? `Selected · ${entry.runId}` : entry.runId} secondary={current.id !== entry.runId} onPress={() => run.selectRun(entry.runId)} />)}</Section> : null}
      <RunMap run={current} onlyExchangePoint={scope} />
      <TripSummaryCard run={current} />

      <Section title="Your stop on this trip">
        {stops.length === 0 ? <Card><Text style={s.muted}>This trip has no stop at {scope}.</Text></Card> : null}
        <StopList stops={stops} />
      </Section>

      <Section title="Pickup handoff">
        {handoffs.length === 0 ? <Card><Text style={s.muted}>No runner at your stall right now.</Text></Card> : null}
        {handoffs.map((handoff) => <SellerPickupQr key={handoff.id} runId={current.id} handoff={handoff} now={now} />)}
      </Section>
    </Page>
  );
}
