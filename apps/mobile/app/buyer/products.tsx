import { Link, useLocalSearchParams } from "expo-router";
import { Image, Text, View } from "react-native";
import { participantHeaders, productCaptureUrl, sessionHeaders } from "../../src/api";
import { useBuyerProducts, useMyIntents } from "../../src/features/buyer";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

function minutesLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
}

export default function Products() {
  const { intentId, productId } = useLocalSearchParams<{ intentId?: string; productId?: string }>();
  const intents = useMyIntents();
  const { products: discovered } = useBuyerProducts(intents.data, 3000);
  const products = discovered.filter((product) => (!intentId || product.intentId === intentId) && (!productId || product.id === productId));

  return (
    <Page eyebrow="RESPONSES TO YOUR INTENTS" title="Products">
      <Section title="Available nearby">
        {products.length === 0 ? (
          <Card><Text style={s.muted}>No products responding yet — sellers see your intent the moment it's posted.</Text></Card>
        ) : null}
        {products.map((product) => (
          <Card key={product.id}>
            <Pill active>{product.status.toUpperCase()} · {minutesLeft(product.expiresAt)} MIN LEFT</Pill>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              {product.photoCaptureRef ? (
                <Image
                  source={{ uri: productCaptureUrl(product.id), headers: { ...sessionHeaders(), ...participantHeaders() } }}
                  style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: "#E5EBE3" }}
                />
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontSize: 19, fontWeight: "800" }}>{product.quantity} {product.unit} {product.shopItem}</Text>
                <Text style={s.body}>From {product.sellerName}</Text>
              </View>
            </View>
            <Text style={s.muted}>Pickup Exchange Point · {product.exchangePoint}</Text>
            <Text style={{ color: colors.green, fontSize: 21, fontWeight: "800" }}>{money(product.priceKobo)}</Text>
            <Link href={{ pathname: "/buyer/negotiation", params: { productId: product.id } }} asChild>
              <Button title={product.status === "negotiating" ? "Continue Negotiation" : "Open Negotiation"} />
            </Link>
          </Card>
        ))}
      </Section>
      <Text style={s.muted}>Products are ephemeral and retire when their Intent expires.</Text>
    </Page>
  );
}
