import { useState } from "react";
import { router } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import { listVocabulary, registerStore, setActiveStore, useActiveMarket, useActiveParticipant, usePoll } from "../../src/api";
import { PayoutAccountCard } from "../../src/features/seller";
import { Button, Card, Field, Label, Page, Pill, Section, colors, s } from "../../src/ui";

/**
 * Joining the market = registering a Store (GLOSSARY): a name, an exchange
 * point, and the shop items this store can supply. The items chosen here are
 * the store's persistent catalog — they grow the market's vocabulary
 * (ADR-0006) and decide which intents reach this store.
 */
export default function JoinMarket() {
  const vocabulary = usePoll(listVocabulary, 30000);
  const market = useActiveMarket();
  const { participant } = useActiveParticipant();
  const [name, setName] = useState("");
  const [exchangePoint, setExchangePoint] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  // After the store registers, the payout-account step (never blocking — skip
  // stays available; settlement just needs the account before it can pay out).
  const [joined, setJoined] = useState(false);

  const toggle = (item: string) =>
    setSelected((current) => (current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item]));

  const addCustom = () => {
    const item = custom.trim();
    if (!item) return;
    if (!selected.some((entry) => entry.toLowerCase() === item.toLowerCase())) setSelected((current) => [...current, item]);
    setCustom("");
  };

  const join = async () => {
    if (!name.trim() || !exchangePoint.trim() || selected.length === 0) {
      Alert.alert("Almost there", "Name your store, set an exchange point, and pick at least one shop item.");
      return;
    }
    setBusy(true);
    try {
      const store = await registerStore({ name: name.trim(), exchangePoint: exchangePoint.trim(), shopItems: selected });
      await setActiveStore(store);
      setJoined(true);
    } catch (error) {
      Alert.alert("Could not join", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const suggestions = (vocabulary.data ?? []).filter(
    (item) => !selected.some((entry) => entry.toLowerCase() === item.toLowerCase()),
  );

  if (joined) {
    const sellerId = participant?.id;
    if (!sellerId) return null;
    return (
      <Page eyebrow={`JOIN ${market.toUpperCase()}`} title="Store registered">
        <Card style={{ backgroundColor: colors.ink }}>
          <Pill active>STORE ACTIVE</Pill>
          <Text style={{ color: "#DCEAE1", lineHeight: 19 }}>Add a verified bank account for seller payouts (optional).</Text>
        </Card>
        <Section title="Payout account (optional)">
          <PayoutAccountCard participantId={sellerId} emptyState="form" />
        </Section>
        <Button title="Continue to your store" onPress={() => router.replace("/seller")} />
      </Page>
    );
  }

  return (
    <Page eyebrow={`JOIN ${market.toUpperCase()}`} title="Create your Store">
      <Section title="Store">
        <Label>Store name</Label>
        <Field value={name} onChangeText={setName} />
        <Label>Exchange point</Label>
        <Field value={exchangePoint} onChangeText={setExchangePoint} placeholder="Market, Stall …" />
      </Section>

      <Section title="Shop items you supply">
        {selected.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {selected.map((item) => (
              <Pressable key={item} onPress={() => toggle(item)}>
                <Pill active>{item} ×</Pill>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={s.muted}>Nothing selected yet — pick below or add your own.</Text>
        )}
        {suggestions.length > 0 ? (
          <>
            <Label>Suggested Shop Items</Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((item) => (
                <Pressable key={item} onPress={() => toggle(item)}>
                  <Pill>{item} +</Pill>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <Label>New Shop Item</Label>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <View style={{ flex: 1 }}>
            <Field value={custom} onChangeText={setCustom} placeholder="e.g. Plantain" onSubmitEditing={addCustom} />
          </View>
          <Button title="Add" secondary onPress={addCustom} />
        </View>
      </Section>

      <Button title={busy ? "Registering…" : "Register Store"} onPress={join} />
    </Page>
  );
}
