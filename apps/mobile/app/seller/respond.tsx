import { useRef, useState } from "react";
import { Alert, Image, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { captureUrl, offerProduct, participantHeaders, sessionHeaders, uploadCapture } from "../../src/api";
import { Button, Card, Field, Label, Page, Pill, Section, colors } from "../../src/ui";

export default function Respond() {
  const params = useLocalSearchParams<{ intentId?: string; shopItem?: string; quantity?: string; unit?: string }>();
  const [price, setPrice] = useState("1650");
  const [qty, setQty] = useState(params.quantity ?? "2");
  const [unit, setUnit] = useState(params.unit ?? "kg");
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [photo, setPhoto] = useState<{ ref: string; url: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [photoSkipped, setPhotoSkipped] = useState(false);
  const item = params.shopItem ?? "Tomatoes";
  const intentId = params.intentId ?? "";

  /**
   * Camera-only capture (AGENTS.md doctrine): the photo goes to the capture
   * endpoint, the Product stores the signed reference — never bytes, never
   * the media library.
   */
  const capture = async () => {
    setCapturing(true);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.6 });
      if (!picture?.uri) throw new Error("no picture returned");
      setPhoto(await uploadCapture(picture.uri));
    } catch (error) {
      Alert.alert("Capture failed", error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
    }
  };

  const send = async () => {
    const priceKobo = Math.round(Number(price) * 100);
    if (priceKobo <= 0 || Number(qty) < 1) {
      Alert.alert("Enter a price and quantity");
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
        ...(photo ? { photoCaptureRef: photo.ref } : {}),
      });
      Alert.alert("Product sent", "The Buyer can now start a Negotiation.", [
        { text: "Done", onPress: () => router.replace("/seller") },
      ]);
    } catch (error) {
      // "intent is not open in market" when the intent expired mid-flow.
      Alert.alert("Could not offer", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page eyebrow="EPHEMERAL OFFER" title="Respond to Intent">
      <Card style={{ backgroundColor: colors.ink }}>
        <Pill active>PRODUCT · RETIRES WITH INTENT</Pill>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "800" }}>{item}</Text>
        <Text style={{ color: "#DCEAE1" }}>A Product stays available until accepted, expired, or withdrawn.</Text>
      </Card>

      <Section title="Product photo">
        {photo ? (
          <>
            <View style={{ height: 200, overflow: "hidden", borderRadius: 18 }}>
              <Image
                source={{ uri: captureUrl(photo.ref), headers: { ...sessionHeaders(), ...participantHeaders() } }}
                style={{ flex: 1 }}
                resizeMode="cover"
              />
            </View>
            <Button title="Retake" secondary onPress={() => setPhoto(null)} />
          </>
        ) : !permission?.granted ? (
          <>
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              Camera access is used only to capture the product photo — never the media library.
            </Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </>
        ) : (
          <>
            <View style={{ height: 200, overflow: "hidden", borderRadius: 18, backgroundColor: "#0B0F0C" }}>
              <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
            </View>
            <Button title={capturing ? "Capturing…" : "Capture photo"} onPress={capture} />
          </>
        )}
        {/* Simulators and browsers have no camera — dev affordance only. */}
        {!photo && !photoSkipped ? (
          <Button title="Continue without photo (dev)" secondary onPress={() => setPhotoSkipped(true)} />
        ) : null}
        {photoSkipped && !photo ? <Pill active={false}>NO PHOTO · DEV</Pill> : null}
      </Section>

      <Section title="Your Product">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Label>Quantity</Label>
            <Field value={qty} onChangeText={setQty} keyboardType="number-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Label>Unit</Label>
            <Field value={unit} onChangeText={setUnit} />
          </View>
        </View>
        <Label>Price (₦)</Label>
        <Field value={price} onChangeText={setPrice} keyboardType="decimal-pad" />
        <Text style={{ color: colors.muted, fontSize: 12 }}>Buyer Price Band guides negotiation; it does not cap your offer.</Text>
        <Button title={busy ? "Sending…" : "Send Product"} onPress={send} />
      </Section>
      <Pill active>Product expires with its Intent · max 30 minutes</Pill>
    </Page>
  );
}
