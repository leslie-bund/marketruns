import { Pressable, Text, View } from "react-native";
import type { RunHandoff } from "@market-runs/proto";
import { Card, Pill, colors, s } from "../../ui";

/** The runner's handoff rows — tap through to the scan/capture screen. */
export function HandoffList({ handoffs, onOpen }: { handoffs: RunHandoff[]; onOpen: (handoffId: string) => void }) {
  if (handoffs.length === 0) return <Text style={s.muted}>No handoff open yet.</Text>;
  return (
    <>
      {handoffs.map((handoff) => (
        <Pressable key={handoff.id} onPress={() => onOpen(handoff.id)}>
          <Card>
            <View style={s.row}>
              <View>
                <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>with {handoff.counterparty}</Text>
                <Text style={s.muted}>{handoff.exchangePoint}</Text>
              </View>
              <Pill active={handoff.status === "confirmed"}>
                {handoff.status === "confirmed" ? "CONFIRMED" : handoff.awaitingPhoto ? "AWAITING PHOTO" : "PENDING"}
              </Pill>
            </View>
          </Card>
        </Pressable>
      ))}
    </>
  );
}
