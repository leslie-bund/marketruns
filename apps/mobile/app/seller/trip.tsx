import { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { useActiveStore } from "../../src/api";
import { HandoffQrCard, RunMap, StopList, TripSummaryCard, useSellerRun } from "../../src/features/run";
import { Card, Page, Section, s } from "../../src/ui";

/**
 * The seller's trip view: the live run through this store's lens. Opened from
 * a specific product it drills into that product's stop (exchangePoint
 * param); opened from the home card it covers every stop at this store's
 * exchange point. The pending handoff shows the one-time QR the runner scans.
 */
export default function SellerTrip() {
  const { exchangePoint } = useLocalSearchParams<{ exchangePoint?: string }>();
  const { store } = useActiveStore();
  // Discovery over the live_runs index finds the trip carrying this store's
  // products — a seller device never has a stored run id of its own.
  const run = useSellerRun(store);
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
          <Text style={s.body}>{run.error ? `Edge: ${run.error}` : "No active run — trips appear here once a buyer checks out with your products."}</Text>
        </Card>
      </Page>
    );
  }

  const stops = current.stops.filter((stop) => stop.exchangePoint === scope);
  const handoffs = current.handoffs.filter((handoff) => handoff.exchangePoint === scope);

  return (
    <Page eyebrow={`${scope.toUpperCase()} · ${run.live ? "LIVE" : "POLLING"}`} title="Trip">
      <RunMap run={current} onlyExchangePoint={scope} />
      <TripSummaryCard run={current} />

      <Section title="Your stop on this trip">
        {stops.length === 0 ? <Card><Text style={s.muted}>This trip has no stop at {scope}.</Text></Card> : null}
        <StopList stops={stops} />
      </Section>

      <Section title="Pickup handoff">
        {handoffs.length === 0 ? <Card><Text style={s.muted}>No runner at your stall right now.</Text></Card> : null}
        {handoffs.map((handoff) => (
          <HandoffQrCard
            key={handoff.id}
            handoff={handoff}
            now={now}
            prompt={`Show this code to ${handoff.counterparty} when the runner arrives`}
          />
        ))}
      </Section>
    </Page>
  );
}
