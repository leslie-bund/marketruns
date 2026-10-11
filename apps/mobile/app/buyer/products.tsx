import { Link } from "expo-router";
import { Text } from "react-native";
import { api } from "../../src/api/client";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../../src/ui";
export default function Products() { return <Page eyebrow="RESPONSES TO YOUR INTENTS" title="Products"><Section title="Available nearby">{api.getProducts().map(product => <Card key={product.id}><Pill active>AVAILABLE · 17 MIN LEFT</Pill><Text style={{ color: colors.ink, fontSize: 19, fontWeight: "800" }}>{product.quantity} {product.unit} {product.shopItem}</Text><Text style={s.body}>From {product.sellerName}</Text><Text style={s.muted}>Pickup Exchange Point · {product.exchangePoint}</Text><Text style={{ color: colors.green, fontSize: 21, fontWeight: "800" }}>{money(product.priceKobo)}</Text><Link href="/buyer/negotiation" asChild><Button title="Open Negotiation" /></Link></Card>)}</Section><Text style={s.muted}>Products are ephemeral and retire when their Intent expires.</Text></Page>; }
