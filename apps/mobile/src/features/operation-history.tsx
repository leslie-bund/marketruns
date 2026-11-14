import { Text, View } from "react-native";
import type { AdminRunSummary } from "@market-runs/proto";
import { getHistory, usePoll } from "../api";
import { Button, Card, Page, Pill, Section, colors, money, s } from "../ui";

export function OperationHistory({ role }: { role: "buyer" | "seller" | "runner" }) {
  const history = usePoll(getHistory, 30000);
  const data = history.data;
  const title = role === "buyer" ? "Cart history" : role === "seller" ? "Sales history" : "Run history";

  return <Page eyebrow="DURABLE HISTORY" title={title}>
    {history.error ? <Card><Text style={s.body}>{history.error}</Text><Button title="Retry" onPress={history.refresh} /></Card> : null}
    {!data && !history.error ? <Card><Text style={s.muted}>Loading your history…</Text></Card> : null}
    {data && role === "buyer" ? <Section title="Previous carts">
      {data.carts.length === 0 ? <Empty label="No retired carts yet." /> : null}
      {data.carts.map((cart) => <Card key={cart.id}>
        <View style={s.row}><Text style={s.body}>{cart.products.length} accepted product(s)</Text><Pill active={cart.reason === "checked-out"}>{cart.reason}</Pill></View>
        <Text style={s.muted}>{cart.market} · {new Date(cart.retiredAt).toLocaleString()}</Text>
        {cart.products.map((product) => <Text key={product.id} style={s.body}>{product.quantity} {product.unit} {product.shopItem} · {money(product.priceKobo)}</Text>)}
        <Text style={{ color: colors.green, fontWeight: "800" }}>Goods {money(cart.products.reduce((sum, product) => sum + product.priceKobo, 0))}</Text>
      </Card>)}
    </Section> : null}
    {data && role === "seller" ? <Section title="Completed sales">
      {data.sales.length === 0 ? <Empty label="No accepted sales yet." /> : null}
      {data.sales.map((sale) => <Card key={sale.productId}>
        <View style={s.row}><Text style={s.body}>{sale.quantity} {sale.unit} {sale.shopItem}</Text><Pill active>{money(sale.priceKobo)}</Pill></View>
        <Text style={s.muted}>{sale.market} · {new Date(sale.soldAt).toLocaleString()}</Text>
      </Card>)}
    </Section> : null}
    {data ? <Section title={role === "buyer" ? "Runs" : role === "seller" ? "Runs containing your sales" : "Previous runs"}>
      {data.runs.length === 0 ? <Empty label="No archived runs yet." /> : null}
      {data.runs.map((run) => <RunCard key={run.runId} run={run} />)}
    </Section> : null}
  </Page>;
}

function Empty({ label }: { label: string }) {
  return <Card><Text style={s.muted}>{label}</Text></Card>;
}

function RunCard({ run }: { run: AdminRunSummary }) {
  return <Card><View style={s.row}><View style={{ flex: 1 }}><Text style={s.body}>{run.market}</Text><Text style={s.muted}>{new Date(run.closedAt).toLocaleString()}</Text></View><Pill active={run.status === "closed"}>{run.status}</Pill></View><Text style={s.muted}>Delivery {money(run.floorRateKobo)}</Text></Card>;
}
