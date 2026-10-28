import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { Card, Page, Pill, s } from "../src/ui";

/** Retired-run notifications land here instead of a live-only run lookup. */
export default function RunReceipt() {
  const { runId, status } = useLocalSearchParams<{ runId?: string; status?: string }>();
  return (
    <Page eyebrow="ARCHIVE" title="Run receipt">
      <Card>
        <Pill active>{(status ?? "closed").toUpperCase()}</Pill>
        <Text style={s.body}>Run · {runId ?? "unknown"}</Text>
        <Text style={s.muted}>
          This run has retired. Its receipt and handoff evidence belong to the archive, not the active-run pool.
        </Text>
      </Card>
    </Page>
  );
}
