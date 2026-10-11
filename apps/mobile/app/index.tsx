import { Link } from "expo-router";
import { Text, View } from "react-native";
import { Button, Card, Page, Pill, Section, colors, s } from "../src/ui";

const roles = [
  { name: "Buyer", text: "Post an Intent, compare Products and build your Cart.", href: "/buyer" as const, icon: "🧺" },
  { name: "Seller", text: "Match shop items to demand and respond with Products.", href: "/seller" as const, icon: "🏪" },
  { name: "Runner", text: "Collect a Cart and complete each Handoff on your Run.", href: "/runner" as const, icon: "🛵" },
];
export default function Launch() { return <Page eyebrow="Market Runs · Balogun" title="Good morning" ><Card style={{ backgroundColor: colors.ink, borderColor: colors.ink, padding: 22 }}><Pill active>ONE MARKET · LAGOS</Pill><Text style={{ color: "#fff", fontSize: 23, fontWeight: "800", lineHeight: 30 }}>Good errands start{`\n`}with a good run.</Text><Text style={{ color: "#D3DDD5", fontSize: 13, lineHeight: 20 }}>Choose a role to pick up where you left off. One person can switch between roles anytime.</Text></Card><Section title="Continue as"><View style={{ gap: 12 }}>{roles.map(role => <Link key={role.name} href={role.href} asChild><Card><View style={s.row}><View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}><Text style={{ fontSize: 26 }}>{role.icon}</Text><View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.ink, fontSize: 17, fontWeight: "800" }}>{role.name}</Text><Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{role.text}</Text></View></View><Text style={{ color: colors.green, fontSize: 22 }}>›</Text></View></Card></Link>)}</View></Section><Text style={{ color: colors.muted, fontSize: 12, textAlign: "center" }}>Internal runners · Floor Rate delivery</Text></Page>; }
