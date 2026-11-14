import { useState } from "react";
import { router } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import { listVocabulary, postIntent, useActiveMarket, usePoll } from "../../src/api";
import { CaptureMediaInput, type CaptureMediaValue } from "../../src/features/capture-media";
import { Button, Field, Label, Page, Pill, Section, colors } from "../../src/ui";

interface IntentDraft {
  key: string;
  item: string;
  qty: string;
  unit: string;
  min: string;
  max: string;
  note: string;
  media: CaptureMediaValue;
}

let draftSequence = 0;
function emptyDraft(): IntentDraft {
  draftSequence += 1;
  return { key: `draft-${draftSequence}`, item: "", qty: "1", unit: "items", min: "", max: "", note: "", media: { photo: null, video: null } };
}

export default function PostIntent() {
  const vocabulary = usePoll(listVocabulary, 30000);
  const market = useActiveMarket();
  const [drafts, setDrafts] = useState<IntentDraft[]>(() => [emptyDraft()]);
  const [busy, setBusy] = useState(false);
  const [capturingCount, setCapturingCount] = useState(0);

  const update = (key: string, patch: Partial<IntentDraft>) => {
    setDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...patch } : draft));
  };

  const submit = async () => {
    const valid = drafts.every((draft) => {
      const quantity = Number(draft.qty);
      const min = Number(draft.min);
      const max = Number(draft.max);
      return draft.item.trim() && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(min) && min >= 0 && Number.isFinite(max) && max >= min;
    });
    if (!valid || drafts.length === 0) {
      Alert.alert("Check your shopping list", "Every item needs a name, positive quantity, and valid price band.");
      return;
    }
    setBusy(true);
    try {
      const results = await Promise.allSettled(drafts.map((draft) => postIntent({
        shopItem: draft.item.trim(),
        quantity: Number(draft.qty),
        unit: draft.unit.trim() || "items",
        priceBand: { minKobo: Math.round(Number(draft.min) * 100), maxKobo: Math.round(Number(draft.max) * 100) },
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        ...(draft.media.photo ? { photoCaptureRef: draft.media.photo.ref } : {}),
        ...(draft.media.video ? { videoCaptureRef: draft.media.video.ref } : {}),
      })));
      const failedKeys = new Set(results.flatMap((result, index) => result.status === "rejected" ? [drafts[index]!.key] : []));
      const failedDrafts = drafts.filter((draft) => failedKeys.has(draft.key));
      const posted = results.length - failedDrafts.length;
      if (failedDrafts.length === 0) {
        Alert.alert("Shopping list posted", `${posted} intent${posted === 1 ? " is" : "s are"} now open for matching stores.`, [
          { text: "Done", onPress: () => router.replace("/buyer") },
        ]);
      } else {
        setDrafts(failedDrafts);
        const firstError = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
        Alert.alert(
          "Some intents were not posted",
          `${posted} posted. ${failedDrafts.length} remain below so you can retry. ${firstError?.reason instanceof Error ? firstError.reason.message : ""}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow={`${market.toUpperCase()} MARKET`} title="Shopping list">
      <Pill active>Each intent expires independently in 30 minutes</Pill>
      {drafts.map((draft, index) => <Section key={draft.key} title={`Item ${index + 1}`} action={drafts.length > 1 ? <Pressable onPress={() => setDrafts((current) => current.filter((entry) => entry.key !== draft.key))}><Text style={{ color: colors.orange, fontWeight: "700" }}>Remove</Text></Pressable> : undefined}>
        {vocabulary.data && vocabulary.data.length > 0 ? <>
          <Label>Shop Item</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {vocabulary.data.map((entry) => <Pressable key={entry} onPress={() => update(draft.key, { item: entry })}><Pill active={draft.item === entry}>{entry}</Pill></Pressable>)}
          </View>
        </> : null}
        <Label>{vocabulary.data && vocabulary.data.length > 0 ? "Other Shop Item" : "Shop Item"}</Label>
        <Field value={draft.item} onChangeText={(item) => update(draft.key, { item })} placeholder="What do you need?" />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}><Label>Quantity</Label><Field value={draft.qty} onChangeText={(qty) => update(draft.key, { qty })} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Label>Unit</Label><Field value={draft.unit} onChangeText={(unit) => update(draft.key, { unit })} placeholder="items" /></View>
        </View>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}><Label>Price Band · min (₦)</Label><Field value={draft.min} onChangeText={(min) => update(draft.key, { min })} keyboardType="decimal-pad" placeholder="0.00" /></View>
          <View style={{ flex: 1 }}><Label>Price Band · max (₦)</Label><Field value={draft.max} onChangeText={(max) => update(draft.key, { max })} keyboardType="decimal-pad" placeholder="0.00" /></View>
        </View>
        <Label>Note (optional)</Label>
        <Field value={draft.note} onChangeText={(note) => update(draft.key, { note })} placeholder="Any preferences?" multiline />
        <CaptureMediaInput
          purpose="intent"
          value={draft.media}
          onChange={(media) => update(draft.key, { media })}
          onBusyChange={(busy) => setCapturingCount((current) => current + (busy ? 1 : -1))}
        />
      </Section>)}
      <Button title="+ Add another item" secondary onPress={() => setDrafts((current) => [...current, emptyDraft()])} />
      <Button title={busy ? "Posting…" : `Post ${drafts.length} intent${drafts.length === 1 ? "" : "s"}`} disabled={busy || capturingCount > 0} onPress={submit} />
    </Page>
  );
}
