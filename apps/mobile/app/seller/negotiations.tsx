import { Link } from "expo-router";
import { Text, View } from "react-native";
import { api } from "../../src/api/client";
import { Card, Page, Pill, Section, colors, money, s } from "../../src/ui";
export default function SellerNegotiations() { return <Page eyebrow="PRIVATE · ONE BUYER PER PRODUCT" title="Negotiations"><Section title="Active threads">{api.getNegotiations().map(n => <Link key={n.id} href="/buyer/negotiation" asChild><Card><View style={s.row}><View><Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>{n.shopItem}</Text><Text style={s.muted}>Buyer thread · one-to-one</Text></View><Pill active>{money(n.latestPriceKobo)}</Pill></View><Text style={s.body}>{n.messages[0]?.text}</Text></Card></Link>)}</Section></Page>; }
