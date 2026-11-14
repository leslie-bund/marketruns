import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { offerProduct } from "../../src/api";
import { CaptureMediaInput, type CaptureMediaValue } from "../../src/features/capture-media";
import { Button, Card, Field, Label, Page, Section, colors } from "../../src/ui";

export default function Respond() {
  const params = useLocalSearchParams<{ intentId?: string; shopItem?: string; quantity?: string; unit?: string }>();
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(params.quantity ?? "1");
  const [unit, setUnit] = useState(params.unit ?? "items");
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [media, setMedia] = useState<CaptureMediaValue>({ photo: null, video: null });
  const item = params.shopItem?.trim() ?? "";
  const intentId = params.intentId ?? "";

  const send = async () => {
    const priceKobo = Math.round(Number(price) * 100);
    if (!intentId || !item || !Number.isFinite(priceKobo) || priceKobo <= 0 || !Number.isFinite(Number(qty)) || Number(qty) < 1) {
      Alert.alert("Check your Product", "Choose an intent and enter a valid price and quantity.");
      return;
    }
    setBusy(true);
    try {
      await offerProduct({
        intentId,
        shopItem: item,
        quantity: Number(qty),
        unit: unit.trim() || "items",
        priceKobo,
        ...(media.photo ? { photoCaptureRef: media.photo.ref } : {}),
        ...(media.video ? { videoCaptureRef: media.video.ref } : {}),
      });
      Alert.alert("Product sent", "The buyer can now negotiate this offer.", [
        { text: "Done", onPress: () => router.replace("/seller") },
      ]);
    } catch (error) {
      Alert.alert("Could not offer", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow="PRODUCT" title="Respond to Intent">
      <Card style={{ backgroundColor: colors.ink }}>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "800" }}>{item || "Selected intent"}</Text>
      </Card>

      <CaptureMediaInput purpose="product" value={media} onChange={setMedia} onBusyChange={setCapturing} />

      <Section title="Your Product">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}><Label>Quantity</Label><Field value={qty} onChangeText={setQty} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Label>Unit</Label><Field value={unit} onChangeText={setUnit} /></View>
        </View>
        <Label>Price (₦)</Label>
        <Field value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" />
        <Button title={busy ? "Sending…" : "Send Product"} disabled={busy || capturing} onPress={send} />
      </Section>
    </Page>
  );
}
