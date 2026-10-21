import { Text, View } from "react-native";
import type { RunStop } from "@market-runs/proto";
import { Card, Pill, colors, s } from "../../ui";
import { formatDistance, formatDuration } from "./format";

/** Ordered stops with routed leg ETAs. Pass a subset to scope to one seller. */
export function StopList({ stops }: { stops: RunStop[] }) {
  return (
    <>
      {stops.map((stop, index) => (
        <Card key={`${stop.sellerName}-${stop.exchangePoint}`}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.ink, fontWeight: "800" }}>{index + 1} · {stop.sellerName}</Text>
              <Text style={s.muted}>
                {stop.exchangePoint}
                {stop.legDurationSeconds !== undefined
                  ? ` · leg ~${formatDuration(stop.legDurationSeconds)} (${formatDistance(stop.legDistanceMeters ?? 0)})`
                  : ""}
              </Text>
              <Text style={s.muted}>{stop.shopItems.join(", ")}</Text>
            </View>
            <Pill active={stop.status === "completed"}>{stop.status.toUpperCase()}</Pill>
          </View>
        </Card>
      ))}
    </>
  );
}
