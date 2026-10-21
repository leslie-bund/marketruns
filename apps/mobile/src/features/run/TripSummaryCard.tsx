import { Text, View } from "react-native";
import type { Run } from "@market-runs/proto";
import { Card, Pill, colors, money, s } from "../../ui";
import { formatDistance, formatDuration } from "./format";

/** The trip status header: progress, routed totals, and the floor rate. */
export function TripSummaryCard({ run }: { run: Run }) {
  const collected = run.stops.filter((stop) => stop.status === "completed").length;
  const remainingSeconds = run.stops
    .filter((stop) => stop.status !== "completed")
    .reduce((total, stop) => total + (stop.legDurationSeconds ?? 0), 0);

  return (
    <Card style={{ backgroundColor: colors.green, borderColor: colors.green }}>
      <Pill active>{run.status.toUpperCase()}</Pill>
      <Text style={{ color: "white", fontSize: 20, fontWeight: "900" }}>
        {collected}/{run.stops.length} stops collected
      </Text>
      <Text style={{ color: "#DCEAE1" }}>
        {run.route
          ? `Trip ${formatDistance(run.route.distanceMeters)} · about ${formatDuration(run.route.durationSeconds)} total`
          : "Route estimate pending"}
        {remainingSeconds > 0 ? ` · ~${formatDuration(remainingSeconds)} of driving left` : ""}
      </Text>
      <View style={s.divider} />
      <View style={s.row}>
        <Text style={{ color: "white" }}>Delivery at the Floor Rate</Text>
        <Text style={{ color: "white", fontWeight: "900" }}>{money(run.floorRateKobo)}</Text>
      </View>
    </Card>
  );
}
