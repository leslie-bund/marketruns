import { useMemo } from "react";
import PayWithFlutterwave from "flutterwave-react-native";
import type { RedirectParams } from "flutterwave-react-native/dist/PayWithFlutterwave";
import { floorRate } from "@market-runs/domain";
import { FLW_PUBLIC_KEY } from "../../api";
import { Button } from "../../ui";

/**
 * Buyer checkout collection (ADR-0009 vendor seam, client side): the official
 * flutterwave-react-native package drives Flutterwave Standard v3 — it POSTs
 * the charge to the provider's sdkcheckout endpoint, opens the hosted page
 * (card / bank transfer / USSD) in its own modal webview, and reports the
 * redirect. That provider UI lives ENTIRELY inside this module; the trigger
 * is the ui barrel's Button via the package's customButton slot, so screens
 * keep composing from ui primitives only.
 *
 * Money stays integer kobo everywhere; the kobo→naira conversion happens only
 * here, at the provider boundary. The charge is verified server-side
 * (POST /payments/charges/confirm) — this module never trusts the webview's
 * word for the amount.
 *
 * Package choice: flutterwave-react-native@1.0.4 (unmaintained since 2023,
 * but a thin wrapper with clean TS types, no removed RN APIs, and only
 * prop-types + react-native-webview as deps — the latter Expo-pinned). A
 * hand-rolled WebView inline-checkout fallback would duplicate exactly what
 * this package already does.
 */

/**
 * Delivery estimate for sizing the charge: the domain floorRate over the
 * market's static fallback inputs (the same defaults the edge's CartDO uses
 * when routing is absent). The SERVER is authoritative — its checkout gate
 * cross-checks the hold against goods + the routed floor rate and refuses
 * honestly on a shortfall; a client-side quote endpoint is the follow-up.
 */
export function estimateDeliveryKobo(): number {
  return floorRate({
    distanceMeters: 3_000,
    estimatedDurationMs: 20 * 60_000,
    baseKobo: 100_000,
    perKilometerKobo: 20_000,
    perMinuteKobo: 500,
  });
}

/** Placeholder customer email — participant ids aren't emails; sanitize for the provider's validation. */
function placeholderEmail(participantId: string): string {
  return `${participantId.replace(/[^a-zA-Z0-9._-]+/g, "-")}@market-runs.local`;
}

export function FlutterwavePayButton({
  amountKobo,
  txRef,
  cartId,
  buyerId,
  title,
  disabled = false,
  beforeLaunch,
  onSuccess,
  onCancel,
  onError,
}: {
  amountKobo: number;
  txRef: string;
  cartId: string;
  buyerId: string;
  title: string;
  /** External busy/invalid state — the trigger inertly shows the title. */
  disabled?: boolean;
  /** Gate the launch (e.g. delivery validation) BEFORE the webview opens. */
  beforeLaunch?: () => boolean;
  /** The provider says the charge completed — confirm server-side before trusting it. */
  onSuccess: (result: { txRef: string; transactionId?: string }) => void;
  /** Cancelled in the webview or aborted — cart intact, no partial state. */
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const options = useMemo(
    () => ({
      authorization: FLW_PUBLIC_KEY,
      tx_ref: txRef,
      // kobo → naira at the provider boundary; Flutterwave expects major units.
      amount: amountKobo / 100,
      currency: "NGN" as const,
      payment_options: "card,banktransfer,ussd",
      customer: { email: placeholderEmail(buyerId), name: buyerId },
      meta: { cartId, buyerId },
      customizations: { title: "Market Runs", description: "Cart checkout" },
    }),
    [amountKobo, txRef, cartId, buyerId],
  );

  return (
    <PayWithFlutterwave
      options={options}
      customButton={({ disabled: pending, onPress }) => {
        // exactOptionalPropertyTypes: omit onPress entirely when inert.
        // beforeLaunch runs at PRESS time (it may Alert), never during render.
        if (disabled || pending) return <Button title={title} />;
        return <Button title={title} onPress={() => { if (!beforeLaunch || beforeLaunch()) onPress(); }} />;
      }}
      onRedirect={(data: RedirectParams) => {
        if (data.status === "successful") {
          onSuccess({ txRef: data.tx_ref, ...(data.transaction_id ? { transactionId: data.transaction_id } : {}) });
        } else {
          onCancel();
        }
      }}
      onAbort={onCancel}
      onInitializeError={(error) => onError(error.message)}
    />
  );
}
