import { Link, router } from "expo-router";
import { Text, View, Pressable} from "react-native";
import { getCart, useActiveMarket } from "../../src/api";
import { useBuyerBadges, useBuyerProducts, useMyIntents } from "../../src/features/buyer";
import { usePoll } from "../../src/api";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";

export default function BuyerHome() {
  const intents = useMyIntents();
  const products = useBuyerProducts(intents.data);
  const cart = usePoll(getCart, 4000);
  const badges = useBuyerBadges();
  const market = useActiveMarket();
  const open = intents.data?.filter((intent) => intent.status === "open") ?? [];

  return (
    <Page eyebrow={`${market.toUpperCase()} MARKET`} title="Your errands">
      <Card style={{ backgroundColor: colors.green, borderColor: colors.green }}>
        <Text style={{ color: "#DAF26B", fontWeight: "800", fontSize: 11, letterSpacing: 1.2 }}>YOUR MARKET IS OPEN</Text>
        <Text style={{ color: "white", fontSize: 22, fontWeight: "800" }}>Fresh finds, one Run.</Text>
        <Text style={{ color: "#DCEAE1", fontSize: 13 }}>{intents.error ? `Edge: ${intents.error}` : "Live against the dev edge worker."}</Text>
        <Link href="/buyer/post" asChild><Button title="＋  Post an Intent" /></Link>
      </Card>

      <Section title="My Intents" action={<Link href="/buyer/post"><Text style={{ color: colors.green, fontWeight: "700" }}>+ New</Text></Link>}>
        {open.length === 0 ? <Text style={s.muted}>No open intents — post one and watch stores respond.</Text> : null}
        {open.map((intent) => (
          <Card key={intent.id}>
            <View style={s.row}>
              <View>
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>{intent.quantity} {intent.unit} {intent.shopItem}</Text>
                <Text style={s.muted}>Price Band {money(intent.priceBand.minKobo)}–{money(intent.priceBand.maxKobo)}</Text>
              </View>
              <Pill active>{intent.status}</Pill>
            </View>
          </Card>
        ))}
      </Section>

      <Section title="Products responding">
        <Card>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "800" }}>
                {products.products.length > 0 ? `${products.products.length} offer(s) live` : "Offers from stores"}
              </Text>
              <Text style={s.muted}>Ephemeral — each retires with its intent</Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
          <Link href="/buyer/products" asChild><Button title="View Products" secondary /></Link>
        </Card>
      </Section>

      <Pressable onPress={() => router.push("/buyer/cart")}>
<Card>
          <View style={s.row}>
            <View>
              <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>Your Cart</Text>
              <Text style={s.muted}>
                {cart.data && cart.data.status === "open"
                  ? `${cart.data.products.length} product(s) · shared deadline`
                  : "Empty — accept a product to start the clock"}
              </Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
        </Card>
        </Pressable>

      <Pressable onPress={() => router.push("/buyer/run")}>
<Card style={badges.track > 0 ? { borderColor: colors.orange, borderWidth: 2 } : undefined}>
          <View style={s.row}>
            <View>
              <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "800" }}>Track your Run</Text>
              <Text style={badges.track > 0 ? { color: colors.orange, fontWeight: "700", fontSize: 13 } : s.muted}>
                {badges.track > 0 ? "Runner is here — show your delivery QR" : "Live stops, handoffs and your delivery QR"}
              </Text>
            </View>
            <Text style={{ color: colors.green }}>→</Text>
          </View>
        </Card>
        </Pressable>
    </Page>
  );
}
