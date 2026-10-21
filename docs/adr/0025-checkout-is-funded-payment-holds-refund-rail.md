# Checkout is funded: collection, holds, the refund rail, and payout accounts

ADR-0023 dispatched settlement money out; ADR-0024 landed Flutterwave as the payout dispatcher and recorded honestly that buyer collection and refunds — the money coming *in* — remained unintegrated. This ADR closes that side: the buyer funds checkout with a card/bank-transfer/USSD charge, the edge holds the money against the cart, the settlement function still decides everything, and the refund rail is what carries the settlement's buyer refund back out. One sentence of doctrine survives all of it: **money-in is now real, and the settlement function is still the only money decision.**

## Server-side verify is the doctrine

The client collects the charge (Flutterwave Standard, webview, via the official `flutterwave-react-native` package) and then *reports* it. Nothing the client reports is trusted: `POST /payments/charges/confirm` re-verifies the charge against the provider's verify API and cross-checks amount, currency, and status before a hold exists. The check is recorded in the usual place — the provider name appears only in the `apps/payments/src/flutterwave/` quarantine, and the hold table deliberately carries `providerTxId`, not `flwTxId` (ADR-0009).

## The hold lifecycle

`payment_holds` (migration 0007) is the money-in ledger: `txRef` unique, `providerTxId`, `cartId`, `buyerId`, `amountKobo`, and status `held → released | partially-refunded | refunded | failed`. A confirmed hold is bound to the run at checkout (hold → `runId`), and a confirmed hold is **reusable** — a checkout retry after a failure presents "payment confirmed" rather than charging the buyer twice. *[Amended: the retry path is completed in ADR-0026 — a retry against a cart that already retired at checkout now answers 409 `cart-already-checked-out` with the runId (the checkout tombstone), so a lost checkout response recovers its run and can never seed a second one.]*

## Checkout gating is opt-in, and dev stays unpaid

Proto `checkout.requested` gained an optional `paymentRef`. When the edge env `PAYMENTS_REQUIRED` is truthy, CartDO requires a confirmed hold matching cart and buyer with amount ≥ goods + floor rate, then binds hold → run. **The dev default is OFF** — unpaid checkout is unchanged, and the whole stack still runs with zero secrets. The gate is doctrine-shaped, not mandate-shaped: collection is a posture you turn on, and the gating check happens in the object that already owns the cart deadline.

## The refund rail: method determines honesty

RunDO emits `payment.refund-requested` whenever the settlement computes `buyerRefundKobo > 0`. The payments worker consumes it and the refund path is method-dependent, recorded honestly:

| Charge method | Refund path |
|---|---|
| Card | Provider refund API (partial supported) |
| Bank transfer / USSD | Terminal `refund-manual` — needs buyer bank details the system doesn't collect |

The non-card row is the same gap class payouts once had before ADR-0024's recipient seam: the system doesn't hold the destination account, so rather than fudging it the refund lands as an explicit, honest terminal state. `payment_refunds` (migration 0007) makes exactly-once structural — `settlementRecordId` unique, one refund record per settlement by construction. Refund-exceeds-hold and provider failures go to `failed` with backoff and the DLQ, same posture as dispatch (ADR-0023).

## Payout accounts: resolve-then-save, DB-first

ADR-0024's `DevRecipientResolver` — env map plus Flutterwave test accounts — is now the *fallback*, not the mechanism. Seller onboarding collects payout details the way the provider wants them: `GET /payments/banks` (6-hour cache) → `POST /payments/payout-accounts/resolve` (provider account-name lookup, so the seller confirms the name the bank returns) → `POST /payments/payout-accounts` (save). The `payout_accounts` table (migration 0007) is the store, and the `RecipientResolver` resolution order is now **DB-first, env-map fallback, test accounts last**. Selling is never blocked on it — the seller home shows the masked account with a change path, and an unresolved recipient still fails honestly as `recipient-unresolved`.

## The estimated-delivery caveat

The charge amount is goods + **estimated** delivery: the routed floor rate is only known server-side at checkout (OSRM is called there, per ADR-0010's mapping), so the mobile client charges against its own estimate and the CartDO gate cross-checks — a shortfall is refused, not clamped. The recorded follow-up is a public quote endpoint so the client can charge the real number instead of an estimate it has to defend.

## Follow-ups recorded, not hidden

- **Quote endpoint** — replace the estimated-delivery charge with the routed floor rate (above).
- **Ops dashboard surfacing** — `/ops/api/admin/holds` and `/ops/api/admin/refunds` proxy reads exist; the dashboard UI that surfaces them does not. Money-in is observable by API, not yet by console.
- **Non-card refunds** — `refund-manual` retires when buyer payout details are collected, the same way `DevRecipientResolver` retired.

## Consequences

- ADR-0024's open follow-up is closed: checkout is funded, and the money-in side has the same discipline as money-out — provider-quarantined, idempotent by schema, DLQ'd on failure, honest about gaps.
- ADR-0007 is reinforced from the other direction: the hold funds the cart, the settlement decides, the refund rail executes the buyer leg — no new money decision appeared anywhere in this work.
- The dev posture is unchanged: `PAYMENTS_REQUIRED` off, unpaid checkout, zero secrets. Collection is additive.
- Seller onboarding now carries the payout detail it always needed; the recipient seam ADR-0024 priced as a seam has its real implementation, and the dev resolver is demoted to fallback.
