import { router } from "expo-router";
import { Text, View, Pressable} from "react-native";
import { useActiveStore } from "../../src/api";
import { useSellerProducts } from "../../src/features/seller";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

export default function SellerNegotiations() {
  const { store } = useActiveStore();
  const mine = useSellerProducts(store?.name);
  const openProduct = (product: (typeof mine.products)[number]) => {
    if (product.status === "accepted") {
      router.push({ pathname: "/seller/trip", params: { exchangePoint: product.exchangePoint } });
    } else {
      router.push({ pathname: "/seller/negotiation", params: { productId: product.id } });
    }
  };

  return (
    <Page title="Negotiations">
      <Section title="Active threads">
        {mine.products.length === 0 ? (
          <Card><Text style={s.muted}>No live products.</Text></Card>
        ) : null}
        {mine.products.map((product) => (
          <Pressable key={product.id} onPress={() => openProduct(product)}>
            <Card>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>{product.shopItem}</Text>
                </View>
                <Pill active>{money(product.priceKobo)}</Pill>
              </View>
              {product.status === "accepted" ? <Button title="View trip" secondary onPress={() => openProduct(product)} /> : null}
            </Card>
          </Pressable>
        ))}
      </Section>
    </Page>
  );
}
