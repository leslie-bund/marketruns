import { useEffect, useMemo, useRef, useState } from "react";
import { router } from "expo-router";
import { Alert, Pressable, Text, View } from "react-native";
import type { CartQuote, Delivery } from "@market-runs/proto";
import {
  ApiError,
  checkout,
  confirmCharge,
  getActiveMarket,
  getActiveParticipant,
  getCart,
  getCartDeliveryOptions,
  identities,
  newTxRef,
  paymentsConfigured,
  quoteCart,
  recordRunId,
  useActiveCartIds,
  useCheckoutPayment,
  usePoll,
  type PaymentAttempt,
} from "../../src/api";
import { checkoutRecoveryRunId } from "../../src/features/buyer/checkout-recovery";
import { FlutterwavePayButton } from "../../src/features/buyer/payment";
import { receiverSelection } from "../../src/features/run";
import { Button, Card, Field, Label, Page, Pill, Section, colors, money, s } from "../../src/ui";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validQuote(quote: CartQuote, cartId: string): boolean {
  return quote.cartId === cartId &&
    [quote.goodsKobo, quote.deliveryKobo, quote.totalKobo, quote.expiresAt].every(Number.isSafeInteger) &&
    quote.goodsKobo >= 0 && quote.deliveryKobo >= 0 && quote.totalKobo === quote.goodsKobo + quote.deliveryKobo;
}

/** Checkout uses a server-routed quote and restart-safe, server-confirmed holds. */
export default function Checkout() {
  const { cartId } = useActiveCartIds();
  const cart = usePoll(getCart, 10000);
  const options = usePoll(getCartDeliveryOptions, 60000);
  const { payment, loading: paymentLoading, saveAttempt, clear: clearPayment } = useCheckoutPayment(cartId);
  const [kind, setKind] = useState<"plus-code" | "muster-point">("plus-code");
  const [code, setCode] = useState("");
  const [muster, setMuster] = useState("");
  const [receiverKind, setReceiverKind] = useState<"buyer" | "designated">("buyer");
  const [receiverName, setReceiverName] = useState("");
  const [accepted, setAccepted] = useState<{ runId: string; floorRateKobo: number; runnerId?: string | null | undefined; deliveryCode?: string } | null>(null);
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteProblem, setQuoteProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentProblem, setPaymentProblem] = useState<string | null>(null);
  const [checkoutProblem, setCheckoutProblem] = useState<string | null>(null);
  const recoveryStarted = useRef(new Set<string>());

  const buyerId = getActiveParticipant()?.id ?? identities.buyer.id;
  const attempts = useMemo(() => payment?.attempts ?? [], [payment]);
  const heldAttempts = attempts.filter((attempt) => attempt.stage === "held");
  const heldRefs = heldAttempts.map((attempt) => attempt.txRef);
  const heldKobo = heldAttempts.reduce((sum, attempt) => sum + (attempt.holdAmountKobo ?? attempt.amountKobo), 0);
  const activeAttempt = attempts.find((attempt) => attempt.stage !== "held") ?? null;
  const outstandingKobo = quote ? Math.max(0, quote.totalKobo - heldKobo) : 0;
  const musterPoints = options.data?.musterPoints ?? [];

  const delivery = (): Delivery => kind === "plus-code"
    ? { kind: "plus-code", plusCode: code.trim() }
    : { kind: "muster-point", name: muster.trim() };

  useEffect(() => {
    setQuote(null);
    setQuoteProblem(null);
    setCheckoutProblem(null);
  }, [cartId, kind, code, muster]);

  const deliveryValid = (): boolean => {
    if (kind === "plus-code" && (!code.trim() || !code.includes("+"))) {
      Alert.alert("Enter a Plus Code", "Delivery requires an explicit Open Location Code.");
      return false;
    }
    if (kind === "muster-point" && (!muster || !musterPoints.includes(muster))) {
      Alert.alert("Choose a Muster Point", "Select one of this market's registered Muster Points.");
      return false;
    }
    if (receiverKind === "designated" && !receiverName.trim()) {
      Alert.alert("Name the receiver", "Enter the person who will give the delivery code to your runner.");
      return false;
    }
    return true;
  };

  const requestQuote = async (): Promise<CartQuote | null> => {
    if (!cartId || !deliveryValid()) return null;
    setQuoteBusy(true);
    setQuoteProblem(null);
    setCheckoutProblem(null);
    try {
      const result = await quoteCart(delivery());
      if (!validQuote(result, cartId)) throw new Error("The server returned an invalid quote; no payment was started.");
      setQuote(result);
      return result;
    } catch (error) {
      setQuote(null);
      setQuoteProblem(`Could not quote this delivery: ${message(error)}`);
      return null;
    } finally {
      setQuoteBusy(false);
    }
  };

  /** Confirm through the server; provider success alone never creates a hold or checkout. */
  const confirmAttempt = async (attempt: PaymentAttempt, transactionId?: string) => {
    if (!cartId) return null;
    setBusy(true);
    setPaymentProblem(null);
    try {
      const hold = await confirmCharge({
        txRef: attempt.txRef,
        ...(transactionId ? { transactionId } : {}),
        expectedAmountKobo: attempt.amountKobo,
        cartId,
      });
      const confirmed = { ...attempt, stage: "held" as const, holdAmountKobo: hold.amountKobo };
      await saveAttempt(confirmed);
      return hold;
    } catch (error) {
      if (error instanceof ApiError && (error.code === "charge-not-found" || error.code === "charge-not-successful")) {
        await saveAttempt({ ...attempt, stage: "ready" });
        setPaymentProblem("The provider has not completed this charge. You can retry the same payment reference safely.");
      } else {
        await saveAttempt({ ...attempt, stage: "confirmation-unknown" });
        setPaymentProblem(`Payment could not be confirmed: ${message(error)} Retry confirmation before starting another payment.`);
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  // A remount sees provider-open/ambiguous attempts and confirms by txRef. A
  // failed recovery is not retried in a render loop; the buyer gets an explicit retry.
  useEffect(() => {
    if (!paymentsConfigured || !cartId || paymentLoading) return;
    const attempt = attempts.find((candidate) =>
      (candidate.stage === "provider-open" || candidate.stage === "confirmation-unknown") && !recoveryStarted.current.has(candidate.txRef));
    if (!attempt) return;
    recoveryStarted.current.add(attempt.txRef);
    void confirmAttempt(attempt);
  }, [payment?.updatedAt, paymentLoading, cartId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mint and persist an exact initial/top-up attempt as soon as the quote is
  // known. Only a provider-confirmed missing charge may reuse a reference with
  // a revised ready amount; ambiguous attempts are never silently repriced.
  useEffect(() => {
    if (!paymentsConfigured || !cartId || !quote || paymentLoading || busy || outstandingKobo <= 0) return;
    if (activeAttempt) {
      if (activeAttempt.stage === "ready" && activeAttempt.amountKobo !== outstandingKobo) {
        void saveAttempt({ ...activeAttempt, amountKobo: outstandingKobo }).catch((error: unknown) => setPaymentProblem(message(error)));
      }
      return;
    }
    void saveAttempt({ txRef: newTxRef(cartId), amountKobo: outstandingKobo, stage: "ready" })
      .catch((error: unknown) => setPaymentProblem(message(error)));
  }, [quote?.quoteId, outstandingKobo, activeAttempt?.txRef, activeAttempt?.stage, activeAttempt?.amountKobo, paymentLoading, busy, cartId]); // eslint-disable-line react-hooks/exhaustive-deps

  const recoverCheckout = async (error: unknown, beforeNavigate?: () => Promise<void>): Promise<boolean> => {
    const runId = checkoutRecoveryRunId(error);
    if (!runId) return false;
    await recordRunId(getActiveMarket(), runId);
    if (beforeNavigate) await beforeNavigate();
    router.replace({ pathname: "/buyer/run", params: { runId } });
    return true;
  };

  const finishCheckout = async (refs = heldRefs) => {
    if (!quote || !deliveryValid()) return;
    setBusy(true);
    setCheckoutProblem(null);
    setPaymentProblem(null);
    try {
      const result = await checkout(delivery(), refs[0], receiverSelection(receiverKind, receiverName), {
        quoteId: quote.quoteId,
        paymentRefs: refs.slice(1),
      });
      await clearPayment();
      setAccepted({
        runId: result.runId,
        floorRateKobo: result.floorRateKobo,
        runnerId: result.runnerId,
        ...(result.deliveryCode ? { deliveryCode: result.deliveryCode } : {}),
      });
    } catch (error) {
      if (await recoverCheckout(error, clearPayment)) return;
      if (error instanceof ApiError && error.code === "payment-hold-insufficient") {
        const shortfall = typeof error.details.shortfallKobo === "number" ? error.details.shortfallKobo : outstandingKobo;
        setPaymentProblem(`The confirmed holds are ${money(shortfall)} short. Pay only that top-up; existing holds will be reused.`);
      } else {
        setCheckoutProblem(`Checkout refused: ${message(error)} Your confirmed payment is preserved for retry.`);
        if (error instanceof ApiError && (error.code === "quote-expired" || error.code === "quote-mismatch")) setQuote(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const onPaid = async ({ txRef, transactionId }: { txRef: string; transactionId?: string }) => {
    if (!activeAttempt || activeAttempt.txRef !== txRef) {
      setPaymentProblem("The provider returned an unexpected reference. No checkout was attempted; retry confirmation.");
      return;
    }
    const hold = await confirmAttempt(activeAttempt, transactionId);
    if (hold) await finishCheckout([...heldRefs, hold.txRef]);
  };

  const beforeLaunch = async (): Promise<boolean> => {
    if (!activeAttempt || !deliveryValid()) return false;
    // Durable write completes before the provider SDK is invoked.
    await saveAttempt({ ...activeAttempt, stage: "provider-open" });
    return true;
  };

  const onCancel = () => {
    if (activeAttempt) void saveAttempt({ ...activeAttempt, stage: "ready" });
    setPaymentProblem("Payment cancelled — your cart and any previously confirmed holds are intact.");
  };

  if (cart.error) {
    return <Page eyebrow="ONE RUNNER · ONE MARKET" title="Checkout"><Card><Text style={s.body}>Could not load your cart: {cart.error}</Text><Button title="Retry" onPress={cart.refresh} /></Card></Page>;
  }

  return (
    <Page eyebrow="ONE RUNNER · ONE MARKET" title="Checkout">
      <Section title="How would you like to receive it?">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable disabled={busy} onPress={() => setKind("plus-code")} style={{ flex: 1 }}>
            <Card style={{ borderColor: kind === "plus-code" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800" }}>My location</Text><Text style={s.muted}>Open Location Code</Text>
            </Card>
          </Pressable>
          <Pressable disabled={busy} onPress={() => setKind("muster-point")} style={{ flex: 1 }}>
            <Card style={{ borderColor: kind === "muster-point" ? colors.green : colors.line }}>
              <Text style={{ color: colors.ink, fontWeight: "800" }}>Muster Point</Text><Text style={s.muted}>Collect yourself</Text>
            </Card>
          </Pressable>
        </View>
        {kind === "plus-code" ? (
          <><Label>Delivery location · Plus Code only</Label><Field value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="Enter your Plus Code" editable={!busy} /><Text style={s.muted}>No location is preselected.</Text></>
        ) : (
          <>
            <Label>Choose a registered Muster Point</Label>
            {options.error ? <Card><Text style={s.body}>Could not load Muster Points: {options.error}</Text><Button title="Retry" secondary onPress={options.refresh} /></Card> : null}
            {!options.error && musterPoints.length === 0 ? <Text style={s.muted}>{options.data ? "No registered Muster Points are available." : "Loading registered Muster Points…"}</Text> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {musterPoints.map((point) => <Pressable key={point} disabled={busy} onPress={() => setMuster(point)}><Pill active={muster === point}>{point}</Pill></Pressable>)}
            </View>
          </>
        )}
      </Section>

      <Section title="Who will receive the delivery?">
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable disabled={busy} onPress={() => setReceiverKind("buyer")} style={{ flex: 1 }}><Card style={{ borderColor: receiverKind === "buyer" ? colors.green : colors.line }}><Text style={{ color: colors.ink, fontWeight: "800" }}>Me</Text></Card></Pressable>
          <Pressable disabled={busy} onPress={() => setReceiverKind("designated")} style={{ flex: 1 }}><Card style={{ borderColor: receiverKind === "designated" ? colors.green : colors.line }}><Text style={{ color: colors.ink, fontWeight: "800" }}>Someone else</Text></Card></Pressable>
        </View>
        {receiverKind === "designated" ? <><Label>Designated receiver's name</Label><Field value={receiverName} onChangeText={setReceiverName} placeholder="Receiver's name" editable={!busy} /></> : null}
        <Text style={s.muted}>Share the 6-digit code only with the person receiving the order.</Text>
      </Section>

      {paymentProblem ? <Card style={{ borderColor: colors.orange }}><Text style={s.body}>{paymentProblem}</Text>{activeAttempt?.stage === "confirmation-unknown" ? <Button title={busy ? "Confirming…" : "Retry payment confirmation"} disabled={busy} onPress={() => void confirmAttempt(activeAttempt)} /> : null}</Card> : null}
      {checkoutProblem ? <Card style={{ borderColor: colors.orange }}><Text style={s.body}>{checkoutProblem}</Text></Card> : null}
      {quoteProblem ? <Card style={{ borderColor: colors.orange }}><Text style={s.body}>{quoteProblem}</Text></Card> : null}

      {accepted ? (
        <Card style={{ backgroundColor: "#EAF1E7" }}>
          <Pill active>{accepted.runnerId ? "RUNNER CLAIMED" : "AWAITING RUNNER"} · FLOOR RATE {money(accepted.floorRateKobo)}</Pill>
          <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 17 }}>Run confirmed</Text>
          <Text style={s.body}>{accepted.runnerId ? "A runner has claimed this Run." : "Your Run is waiting for an internal runner to claim it."}</Text>
          {accepted.deliveryCode ? <Text style={{ color: colors.ink, fontWeight: "900", fontSize: 28, letterSpacing: 6 }}>Delivery code · {accepted.deliveryCode}</Text> : null}
          <Button title="Track your Run" onPress={() => router.replace({ pathname: "/buyer/run", params: { runId: accepted.runId } })} />
          <Button title="Back to start" secondary onPress={() => router.replace("/")} />
        </Card>
      ) : (
        <>
          <Card style={{ backgroundColor: "#EAF1E7" }}>
            <Text style={{ color: colors.ink, fontWeight: "800" }}>Your Run includes</Text>
            <Text style={s.body}>Every accepted product · Internal Runner at the Floor Rate</Text>
            {quote ? <>
              <View style={s.divider} />
              <View style={s.row}><Text style={s.body}>Products</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(quote.goodsKobo)}</Text></View>
              <View style={s.row}><Text style={s.body}>Delivery (server quote)</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(quote.deliveryKobo)}</Text></View>
              <View style={s.row}><Text style={{ color: colors.ink, fontWeight: "800" }}>Quoted total</Text><Text style={{ color: colors.green, fontWeight: "900", fontSize: 17 }}>{money(quote.totalKobo)}</Text></View>
              {heldKobo > 0 ? <View style={s.row}><Text style={s.body}>Confirmed holds</Text><Text style={{ color: colors.ink, fontWeight: "800" }}>{money(heldKobo)}</Text></View> : null}
            </> : null}
          </Card>

          {!cartId || !cart.data ? <Card><Text style={s.body}>{cartId ? "Loading cart…" : "Your cart is empty — accept a product before checkout."}</Text>{cartId ? <Button title="Retry" secondary onPress={cart.refresh} /> : null}</Card> : null}

          {paymentsConfigured && cartId && !quote ? <Button title={quoteBusy ? "Getting routed quote…" : heldRefs.length > 0 ? "Refresh quote (payment confirmed)" : "Get secure payment quote"} disabled={quoteBusy || busy || paymentLoading} onPress={() => void requestQuote()} /> : null}

          {paymentsConfigured && quote && outstandingKobo > 0 && activeAttempt ? (
            <FlutterwavePayButton
              amountKobo={activeAttempt.amountKobo}
              txRef={activeAttempt.txRef}
              cartId={quote.cartId}
              buyerId={buyerId}
              title={busy ? "Confirming payment…" : `${heldRefs.length > 0 ? "Top up" : "Pay"} ${money(activeAttempt.amountKobo)}`}
              disabled={busy || quoteBusy || activeAttempt.stage !== "ready"}
              beforeLaunch={beforeLaunch}
              onSuccess={(result) => void onPaid(result)}
              onCancel={onCancel}
              onError={(problem) => {
                if (activeAttempt) void saveAttempt({ ...activeAttempt, stage: "confirmation-unknown" });
                setPaymentProblem(`Payment start is unconfirmed: ${problem} Retry confirmation before another payment.`);
              }}
            />
          ) : null}

          {paymentsConfigured && quote && outstandingKobo === 0 && heldRefs.length > 0 ? <Button title={busy ? "Confirming…" : "Complete checkout (payment confirmed)"} disabled={busy || quoteBusy} onPress={() => void finishCheckout()} /> : null}
          {!paymentsConfigured ? <Button title={busy ? "Confirming…" : "Confirm checkout"} disabled={busy || !cartId || !cart.data} onPress={() => void finishUnpaid()} /> : null}
        </>
      )}
    </Page>
  );

  async function finishUnpaid(): Promise<void> {
    if (!deliveryValid()) return;
    setBusy(true);
    setCheckoutProblem(null);
    try {
      const result = await checkout(delivery(), undefined, receiverSelection(receiverKind, receiverName));
      setAccepted({ runId: result.runId, floorRateKobo: result.floorRateKobo, runnerId: result.runnerId, ...(result.deliveryCode ? { deliveryCode: result.deliveryCode } : {}) });
    } catch (error) {
      if (await recoverCheckout(error)) return;
      setCheckoutProblem(`Checkout refused: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }
}
