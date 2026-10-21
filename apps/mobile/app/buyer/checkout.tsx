import { useEffect, useMemo, useState } from "react";
import { router } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import {
  ApiError,
  checkout,
  confirmCharge,
  getCart,
  getActiveParticipant,
  identities,
  newTxRef,
  paymentsConfigured,
  useActiveCartIds,
  usePoll,
} from "../../src/api";
import { estimateDeliveryKobo, FlutterwavePayButton } from "../../src/features/buyer/payment";
import { Button, Card, Field, Label, Page, Pill, Section, colors, money, s } from "../../src/ui";

/**
 * Checkout: pick the delivery, pay (when collection is configured), confirm.
 *
 * Payment posture: with EXPO_PUBLIC_FLW_PUBLIC_KEY set, the buyer pays the
 * estimated total (goods + estimated floor-rate delivery) through the
 * Flutterwave Standard checkout; the charge is then confirmed server-side
 * (POST /payments/charges/confirm — the provider verify API is the only
 * truth) and the hold's txRef rides checkout.requested as paymentRef. The
 * edge's PAYMENTS_REQUIRED gate cross-checks the hold against goods + the
 * ROUTED floor rate and refuses honestly on a shortfall. Without the key the
 * screen is exactly the unpaid dev checkout (gate off, dev default).
 *
 * Failure honesty: cancel/failure leaves the cart intact and shows why. A
 * confirmed hold is never re-charged — if checkout itself refuses afterwards
 * (close gate, deadline), retrying reuses the same paymentRef.
 */
export default function Checkout() {
  const { cartId } = useActiveCartIds();
  const cart = usePoll(getCart, 10000);
  const [kind, setKind] = useState<"plus-code" | "muster-point">("plus-code");
  // Real short code for Balogun Market (6FR5F93V+JV) so routing decodes it.
  const [code, setCode] = useState("F93V+JV Lagos");
  const [muster, setMuster] = useState("Balogun Market Partner");
  const [accepted, setAccepted] = useState<{ runId: string; floorRateKobo: number } | null>(null);
  const [busy, setBusy] = useState(false);

  /* Payment state: one txRef per screen mount; the hold, once confirmed, is reused on checkout retries. */
  const [txRef, setTxRef] = useState<string | null>(null);
  const [holdRef, setHoldRef] = useState<string | null>(null);
  const [paymentProblem, setPaymentProblem] = useState<string | null>(null);

  const goodsKobo = useMemo(
    () => (cart.data && cart.data.status === "open" ? cart.data.products.reduce((sum, p) => sum + p.priceKobo, 0) : 0),
    [cart.data],
  );
  const deliveryKobo = useMemo(() => (paymentsConfigured ? estimateDeliveryKobo() : 0), []);
  const chargeKobo = goodsKobo + deliveryKobo;
  const buyerId = getActiveParticipant()?.id ?? identities.buyer.id;

  // The txRef keys the charge AND the hold (idempotency) — mint it once the cart id is known.
  useEffect(() => {
    if (paymentsConfigured && cartId && txRef === null) setTxRef(newTxRef(cartId));
  }, [cartId, txRef]);

  const delivery = () =>
    kind === "plus-code" ? { kind: "plus-code" as const, plusCode: code.trim() } : { kind: "muster-point" as const, name: muster.trim() };

  const deliveryValid = () => {
    if (kind === "plus-code" && !code.includes("+")) {
      Alert.alert("Enter a Plus Code", "Delivery uses Open Location Codes only.");
      return false;
    }
    return true;
  };

  /** checkout.requested — with the hold's paymentRef when one was confirmed. */
  const finishCheckout = async (paymentRef?: string) => {
    setBusy(true);
    try {
      const result = await checkout(delivery(), paymentRef);
      setAccepted({ runId: result.runId, floorRateKobo: result.floorRateKobo });
    } catch (error) {
      // The close gate, cart deadline and payment gate refuse clearly — surface the reason.
      Alert.alert("Checkout refused", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** Unpaid dev checkout (collection not configured) — today's flow, unchanged. */
  const confirm = async () => {
    if (!deliveryValid()) return;
    await finishCheckout();
  };

  /** Flutterwave says the charge completed — confirm server-side, then check out with the hold. */
  const onPaid = async ({ txRef: paidRef, transactionId }: { txRef: string; transactionId?: string }) => {
    if (!cartId) return;
    setPaymentProblem(null);
    setBusy(true);
    try {
      const hold = await confirmCharge({
        txRef: paidRef,
        ...(transactionId ? { transactionId } : {}),
        expectedAmountKobo: chargeKobo,
        cartId,
      });
      setHoldRef(hold.txRef);
      await finishCheckout(hold.txRef);
    } catch (error) {
      // 409 amount-mismatch / charge-not-successful / hold-conflict, 404
      // charge-not-found — the server's message says exactly which.
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
      setPaymentProblem(`Payment could not be confirmed: ${message} Your cart is intact — no money moved unless the provider says so.`);
    } finally {
      setBusy(false);
    }
  };

  const paying = paymentsConfigured && holdRef === null;

  return (
    <Page eyebrow="ONE RUNNER · ONE MARKET" title="Checkout">
      <Section title="How would you like to receive it?">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable onPress={() => setKind("plus-code")} style={{ flex: 1 }}>
            <Card style={{ borderColor: kind === "plus-code" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800" }}>My location</Text>
              <Text style={s.muted}>Open Location Code</Text>
            </Card>
          </Pressable>
          <Pressable onPress={() => setKind("muster-point")} style={{ flex: 1 }}>
            <Card style={{ borderColor: kind === "muster-point" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800" }}>Muster Point</Text>
              <Text style={s.muted}>Collect yourself</Text>
            </Card>
          </Pressable>
        </View>
        {kind === "plus-code" ? (
          <>
            <Label>Delivery location · Plus Code only</Label>
            <Field value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="6FR5+8X Lagos" />
            <Text style={s.muted}>Enter an Open Location Code. No street address needed.</Text>
          </>
        ) : (
          <>
            <Label>Choose a Muster Point</Label>
            <Field value={muster} onChangeText={setMuster} placeholder="Muster Point" />
          </>
        )}
      </Section>

      {paymentProblem ? (
        <Card style={{ borderColor: colors.orange }}>
          <Text style={s.body}>{paymentProblem}</Text>
        </Card>
      ) : null}

      {accepted ? (
        <Card style={{ backgroundColor: "#EAF1E7" }}>
          <Pill active>RUN ASSIGNED · FLOOR RATE {money(accepted.floorRateKobo)}</Pill>
          <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>Run confirmed</Text>
          <Text style={s.body}>
            Your runner is collecting from every seller. Handoffs confirm by QR scan or auto-confirm after 3 minutes;
            a 30-minute dispute window opens after final delivery.
          </Text>
          <Button title="Track your Run" onPress={() => router.replace("/buyer/run")} />
          <Button title="Back to start" secondary onPress={() => router.replace("/")} />
        </Card>
      ) : (
        <>
          <Card style={{ backgroundColor: "#EAF1E7" }}>
            <Text style={{ color: colors.ink, fontWeight: "800" }}>Your Run includes</Text>
            <Text style={s.body}>Every accepted product · Internal Runner at the Floor Rate</Text>
            {paying ? (
              <>
                <View style={s.divider} />
                <View style={s.row}><Text style={s.body}>Products</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(goodsKobo)}</Text></View>
                <View style={s.row}><Text style={s.body}>Delivery (estimated)</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(deliveryKobo)}</Text></View>
                <View style={s.row}><Text style={{ color: colors.ink, fontWeight: "800" }}>You pay</Text><Text style={{ color: colors.green, fontWeight: "900", fontSize: 17 }}>{money(chargeKobo)}</Text></View>
              </>
            ) : null}
          </Card>

          {paying && cartId && txRef ? (
            <FlutterwavePayButton
              amountKobo={chargeKobo}
              txRef={txRef}
              cartId={cartId}
              buyerId={buyerId}
              title={busy ? "Confirming payment…" : `Pay ${money(chargeKobo)}`}
              disabled={busy}
              beforeLaunch={deliveryValid}
              onSuccess={(result) => void onPaid(result)}
              onCancel={() => setPaymentProblem("Payment cancelled — your cart is intact, nothing was charged.")}
              onError={(message) => setPaymentProblem(`Could not start payment: ${message}`)}
            />
          ) : null}

          {/* A confirmed hold survives a refused checkout — retry reuses it, never re-charges. */}
          {holdRef !== null ? (
            <Button title={busy ? "Confirming…" : "Retry checkout (payment confirmed)"} onPress={() => void finishCheckout(holdRef)} />
          ) : null}

          {!paymentsConfigured ? <Button title={busy ? "Confirming…" : "Confirm checkout"} onPress={confirm} /> : null}
          {paymentsConfigured && !cartId ? (
            <Text style={s.muted}>Your cart is empty — accept a product before checkout.</Text>
          ) : null}
        </>
      )}
    </Page>
  );
}
