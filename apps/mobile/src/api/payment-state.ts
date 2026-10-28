import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { useActiveMarket } from "./active-market";

/** Restart-safe collection state. References and expected amounts are written before provider launch. */
export type PaymentAttemptStage = "ready" | "provider-open" | "confirmation-unknown" | "held";

export interface PaymentAttempt {
  txRef: string;
  amountKobo: number;
  stage: PaymentAttemptStage;
  /** Server-verified amount; present only after confirmation. */
  holdAmountKobo?: number;
}

export interface CheckoutPaymentState {
  cartId: string;
  attempts: PaymentAttempt[];
  updatedAt: number;
}

type PaymentStateMap = Record<string, Record<string, CheckoutPaymentState>>;

const STORAGE_KEY = "market-runs:checkout-payment-state";
let cache: PaymentStateMap = {};
let loaded = false;
const listeners = new Set<() => void>();

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = raw ? (JSON.parse(raw) as PaymentStateMap) : {};
  loaded = true;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getStoredCheckoutPayment(market: string, cartId: string): CheckoutPaymentState | null {
  return cache[market]?.[cartId] ?? null;
}

export async function savePaymentAttempt(market: string, cartId: string, attempt: PaymentAttempt): Promise<void> {
  if (!attempt.txRef.trim()) throw new Error("A payment reference is required.");
  if (!Number.isSafeInteger(attempt.amountKobo) || attempt.amountKobo <= 0) throw new Error("Payment amount must be positive whole kobo.");
  if (attempt.holdAmountKobo !== undefined && (!Number.isSafeInteger(attempt.holdAmountKobo) || attempt.holdAmountKobo <= 0)) {
    throw new Error("Confirmed hold amount must be positive whole kobo.");
  }
  await ensureLoaded();
  const current = cache[market]?.[cartId] ?? { cartId, attempts: [], updatedAt: Date.now() };
  const attempts = [...current.attempts.filter((candidate) => candidate.txRef !== attempt.txRef), attempt];
  const next = { ...current, attempts, updatedAt: Date.now() };
  cache = { ...cache, [market]: { ...cache[market], [cartId]: next } };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  notify();
}

export async function clearCheckoutPayment(market: string, cartId: string): Promise<void> {
  await ensureLoaded();
  if (!cache[market]?.[cartId]) return;
  const remaining = { ...cache[market] };
  delete remaining[cartId];
  cache = { ...cache, [market]: remaining };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  notify();
}

/** Dev identity reset: collection references belong to the previous participant. */
export async function clearCheckoutPaymentState(): Promise<void> {
  cache = {};
  loaded = true;
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
  notify();
}

export function useCheckoutPayment(cartId: string | null): {
  payment: CheckoutPaymentState | null;
  loading: boolean;
  saveAttempt: (attempt: PaymentAttempt) => Promise<void>;
  clear: () => Promise<void>;
} {
  const market = useActiveMarket();
  const [ready, setReady] = useState(loaded);
  const [, setTick] = useState(0);

  useEffect(() => {
    void ensureLoaded().then(() => {
      setReady(true);
      setTick((tick) => tick + 1);
    });
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const saveAttempt = useCallback((attempt: PaymentAttempt) => {
    if (!cartId) return Promise.reject(new Error("A cart is required before payment."));
    return savePaymentAttempt(market, cartId, attempt);
  }, [market, cartId]);
  const clear = useCallback(() => cartId ? clearCheckoutPayment(market, cartId) : Promise.resolve(), [market, cartId]);

  return {
    payment: cartId ? getStoredCheckoutPayment(market, cartId) : null,
    loading: !ready,
    saveAttempt,
    clear,
  };
}
