import { createElement, useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { participantHeaders, sessionHeaders } from "../api";

export function ProductVideo({ uri }: { uri: string }) {
  return Platform.OS === "web" ? <WebVideo uri={uri} /> : <NativeVideo uri={uri} />;
}

function NativeVideo({ uri }: { uri: string }) {
  const source = useMemo(() => ({ uri, headers: { ...sessionHeaders(), ...participantHeaders() }, useCaching: false }), [uri]);
  const player = useVideoPlayer(source);
  return <View style={{ height: 220, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}><VideoView player={player} style={{ flex: 1 }} contentFit="contain" playsInline /></View>;
}

function WebVideo({ uri }: { uri: string }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let active = true;
    setSource("");
    setError("");
    void fetch(uri, { headers: { ...sessionHeaders(), ...participantHeaders() } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Video request failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [uri]);

  return <View style={{ height: 220, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
    {source ? createElement("video", { src: source, controls: true, playsInline: true, style: { width: "100%", height: "100%" } }) : createElement("span", { style: { color: "white", padding: 16 } }, error || "Loading video…")}
  </View>;
}
