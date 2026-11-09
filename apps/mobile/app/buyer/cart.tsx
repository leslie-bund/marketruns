import { useEffect, useState } from "react";
import { Link } from "expo-router";
import { Text, View } from "react-native";
import { getCart , useActiveMarket} from "../../src/api";
import { usePoll } from "../../src/api";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

/** The cart's single shared lap-timer, straight from the server (ADR-0003). */
export default function CartScreen() {
  const market = useActiveMarket();
  const cart = usePoll(getCart, 2500);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = cart.data && cart.data.status === "open" ? cart.data : null;
  const left = current ? Math.max(0, Math.floor((current.deadline - now) / 1000)) : 0;
  const total = current?.products.reduce((sum, p) => sum + p.priceKobo, 0) ?? 0;

  if (cart.error) {
    return (
      <Page eyebrow={`${market.toUpperCase()} MARKET`} title="Your Cart">
        <Card><Text style={s.body}>Could not load your cart: {cart.error}</Text><Button title="Retry" onPress={cart.refresh} /></Card>
      </Page>
    );
  }

  if (current === null) {
    return (
      <Page eyebrow={`${market.toUpperCase()} MARKET`} title="Your Cart">
        <Card>
          <Text style={s.body}>{cart.data ? "This cart is no longer open." : "Your cart is empty."}</Text>
          <Text style={s.muted}>Accept a product from a negotiation and the shared clock starts.</Text>
          <Link href="/buyer/products" asChild><Button title="Browse Products" secondary /></Link>
        </Card>
      </Page>
    );
  }

  return (
    <Page eyebrow={`${current.market.toUpperCase()} MARKET`} title="Your Cart">
      <Card style={{ backgroundColor: left ? colors.ink : "#8E4338", borderColor: "transparent" }}>
        <Text style={{ color: "#D9F26B", fontWeight: "800", letterSpacing: 1 }}>CART EXPIRES IN</Text>
        <Text style={{ color: "white", fontWeight: "900", fontSize: 42, fontVariant: ["tabular-nums"] }}>
          {String(Math.floor(left / 60)).padStart(2, "0")}:{String(left % 60).padStart(2, "0")}
        </Text>
        <Text style={{ color: "#E1E8E1", fontSize: 13 }}>
          All Products in this Cart expire together at {new Date(current.deadline).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}.
        </Text>
      </Card>

      <Section title={`${current.products.length} Products`}>
        {current.products.map((p) => (
          <Card key={p.id}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>{p.quantity} {p.unit} {p.shopItem}</Text>
                <Text style={s.muted}>{p.sellerName} · {p.exchangePoint}</Text>
              </View>
              <Text style={{ color: colors.green, fontWeight: "800" }}>{money(p.priceKobo)}</Text>
            </View>
          </Card>
        ))}
      </Section>

      <Card>
        <View style={s.row}><Text style={s.body}>Products subtotal</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(total)}</Text></View>
        <View style={s.row}><Text style={s.body}>Delivery</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>Floor Rate, at checkout</Text></View>
        <View style={s.divider} />
        <View style={s.row}><Text style={{ color: colors.ink, fontWeight: "800" }}>Estimated total</Text><Text style={{ color: colors.green, fontWeight: "900", fontSize: 17 }}>{money(total)} + delivery</Text></View>
      </Card>

      <Link href="/buyer/checkout" asChild><Button title="Checkout" /></Link>
    </Page>
  );
}
