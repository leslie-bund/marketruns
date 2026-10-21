import { router } from "expo-router";
import { Text, View, Pressable} from "react-native";
import { useActiveStore } from "../../src/api";
import { useSellerProducts } from "../../src/features/seller";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

export default function SellerNegotiations() {
  const { store } = useActiveStore();
  const mine = useSellerProducts(store?.name);

  return (
    <Page eyebrow="PRIVATE · ONE BUYER PER PRODUCT" title="Negotiations">
      <Section title="Active threads">
        {mine.products.length === 0 ? (
          <Card><Text style={s.muted}>No live products — respond to an intent to open a thread.</Text></Card>
        ) : null}
        {mine.products.map((product) => (
          <Pressable
            key={product.id}
            onPress={() =>
              product.status === "accepted"
                ? router.push({ pathname: "/seller/trip", params: { exchangePoint: product.exchangePoint } })
                : router.push({ pathname: "/seller/negotiation", params: { productId: product.id } })
            }
          >
            <Card>
              <View style={s.row}>
                <View>
                  <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>{product.shopItem}</Text>
                  <Text style={s.muted}>
                    {product.status === "accepted" ? "Sold — view the trip it is on" : "Buyer thread · one-to-one"}
                  </Text>
                </View>
                <Pill active>{money(product.priceKobo)}</Pill>
              </View>
              {product.status === "accepted" ? <Button title="View trip" secondary /> : null}
            </Card>
          </Pressable>
        ))}
      </Section>
    </Page>
  );
}
