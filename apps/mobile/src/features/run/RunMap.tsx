import { useEffect, useRef } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import type { GeoPointValue, Run } from "@market-runs/proto";
import { colors, s } from "../../ui";

/**
 * The trip map atom: the routed path, seller stop markers, the delivery
 * destination, and the runner's live fix — everything the wire already
 * carries on the Run. react-native-maps is free and ships inside Expo Go
 * (Apple Maps on iOS, Google Maps on Android — no API keys). On web it
 * degrades to a summary card.
 */

type MapsModule = typeof import("react-native-maps");

let maps: MapsModule | null = null;
if (Platform.OS !== "web") {
  try {
    // Lazy require: Metro bundles the module but web never evaluates it.
    maps = require("react-native-maps") as MapsModule;
  } catch {
    maps = null;
  }
}

export function RunMap({ run, onlyExchangePoint }: { run: Run; onlyExchangePoint?: string }) {
  const viewRef = useRef<InstanceType<MapsModule["default"]> | null>(null);
  const stops = run.stops.filter(
    (stop) => stop.location && (onlyExchangePoint === undefined || stop.exchangePoint === onlyExchangePoint),
  );
  const geometry = run.route?.geometry ?? [];
  const destination = run.route?.destination;
  const runnerFix = run.location;

  const points: GeoPointValue[] = [
    ...geometry,
    ...stops.map((stop) => stop.location!),
    ...(destination ? [destination] : []),
    ...(runnerFix ? [runnerFix] : []),
  ];

  useEffect(() => {
    if (!maps || points.length === 0) return;
    viewRef.current?.fitToCoordinates(points, {
      edgePadding: { top: 48, right: 48, bottom: 48, left: 48 },
      animated: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, points.length]);

  if (!maps || points.length === 0) {
    return (
      <View style={[styles.frame, styles.fallback]}>
        <Text style={s.muted}>
          {maps ? "Route geometry arrives with the next route fix." : "The trip map is available in the mobile app."}
        </Text>
      </View>
    );
  }

  const MapView = maps.default;
  const Marker = maps.Marker;
  const Polyline = maps.Polyline;

  return (
    <View style={styles.frame}>
      <MapView ref={viewRef} style={StyleSheet.absoluteFill} initialRegion={regionAround(points)}>
        {geometry.length > 1 ? (
          <Polyline coordinates={geometry} strokeColor={colors.green} strokeWidth={4} />
        ) : null}
        {stops.map((stop, index) => (
          <Marker
            key={`${stop.sellerName}-${stop.exchangePoint}`}
            coordinate={stop.location!}
            title={`${index + 1} · ${stop.sellerName}`}
            description={stop.shopItems.join(", ")}
            pinColor={stop.status === "completed" ? colors.green : "#C96F2F"}
          />
        ))}
        {destination ? <Marker coordinate={destination} title="Delivery" pinColor="#2F5AC9" /> : null}
        {runnerFix ? (
          <Marker coordinate={runnerFix} title="Runner" description="live location" pinColor="#111111" />
        ) : null}
      </MapView>
    </View>
  );
}

function regionAround(points: GeoPointValue[]) {
  const lats = points.map((point) => point.latitude);
  const lngs = points.map((point) => point.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.004, (maxLat - minLat) * 1.6),
    longitudeDelta: Math.max(0.004, (maxLng - minLng) * 1.6),
  };
}

const styles = StyleSheet.create({
  frame: {
    height: 220,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#E5EBE3",
  },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
});
