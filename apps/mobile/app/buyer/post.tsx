import { useState } from "react";
import { router } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import { listVocabulary, postIntent, useActiveMarket, usePoll } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors } from "../../src/ui";

export default function PostIntent() {
  const vocabulary = usePoll(listVocabulary, 30000);
  const market = useActiveMarket();
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("2");
  const [unit, setUnit] = useState("kg");
  const [min, setMin] = useState("1200");
  const [max, setMax] = useState("1800");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!item.trim() || Number(qty) < 1 || Number(max) < Number(min)) {
      Alert.alert("Check your Intent", "Enter a Shop Item, quantity and valid Price Band.");
      return;
    }
    setBusy(true);
    try {
      await postIntent({
        shopItem: item.trim(),
        quantity: Number(qty),
        unit: unit.trim() || "items",
        priceBand: { minKobo: Math.round(Number(min) * 100), maxKobo: Math.round(Number(max) * 100) },
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      Alert.alert("Intent posted", "Stores matching your Shop Item can now respond.", [
        { text: "Done", onPress: () => router.replace("/buyer") },
      ]);
    } catch (error) {
      Alert.alert("Could not post", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`${market.toUpperCase()} MARKET`} title="Post an Intent">
      <Card style={{ backgroundColor: colors.ink }}>
        <Text style={{ color: "#DAF26B", fontWeight: "800" }}>Tell nearby stores what you need</Text>
        <Text style={{ color: "white", lineHeight: 21 }}>Matching Shop Items notify Sellers in your Market. Your Price Band guides the conversation.</Text>
      </Card>
      <Section title="What do you need?">
        {(vocabulary.data ?? []).length > 0 ? (
          <>
            <Label>Shop Item — pick what stores in this market supply</Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {(vocabulary.data ?? []).map((entry) => (
                <Pressable key={entry} onPress={() => setItem(entry)}>
                  <Pill active={item === entry}>{entry}</Pill>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <Label>{(vocabulary.data ?? []).length > 0 ? "Or name another item" : "Shop Item"}</Label>
        <Field value={item} onChangeText={setItem} placeholder="e.g. ripe tomatoes" />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Label>Quantity</Label>
            <Field value={qty} onChangeText={setQty} keyboardType="number-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Label>Unit</Label>
            <Field value={unit} onChangeText={setUnit} placeholder="kg" />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Label>Price Band · min (₦)</Label>
            <Field value={min} onChangeText={setMin} keyboardType="decimal-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Label>Price Band · max (₦)</Label>
            <Field value={max} onChangeText={setMax} keyboardType="decimal-pad" />
          </View>
        </View>
        <Label>Note (optional)</Label>
        <Field value={note} onChangeText={setNote} placeholder="Any preferences?" multiline />
      </Section>
      <Pill active>Intent expires in 30 minutes</Pill>
      <Button title={busy ? "Posting…" : "Post Intent"} onPress={submit} />
    </Page>
  );
}
