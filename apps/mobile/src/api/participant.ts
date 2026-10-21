import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import type { Participant } from "@market-runs/proto";

/**
 * The device's onboarded participant (ADR-0004/0015). Onboarding lands a KYC
 * verification through the vendor-neutral seam; afterwards every request
 * carries the participant's identity headers, which the edge's single auth
 * seam resolves (resolveParticipant). Replaced by real sessions when the
 * identity layer ships — the seam does not move.
 */

const STORAGE_KEY = "market-runs:active-participant";

let cache: Participant | null = null;
let loaded = false;
const listeners = new Set<(participant: Participant | null) => void>();

export function getActiveParticipant(): Participant | null {
  return cache;
}

/** The auth seam on the client: identity headers for every request. */
export function participantHeaders(): Record<string, string> {
  const participant = cache;
  if (!participant) return {};
  return { "x-participant-id": participant.id, "x-participant-role": participant.role };
}

export async function loadActiveParticipant(): Promise<Participant | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  cache = raw ? (JSON.parse(raw) as Participant) : null;
  loaded = true;
  return cache;
}

export async function setActiveParticipant(participant: Participant | null): Promise<void> {
  cache = participant;
  loaded = true;
  if (participant) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(participant)).catch(() => undefined);
  else await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
  for (const listener of listeners) listener(participant);
}

export function useActiveParticipant(): { participant: Participant | null; loading: boolean } {
  const [participant, setParticipant] = useState<Participant | null>(cache);
  const [loading, setLoading] = useState(!loaded);

  useEffect(() => {
    void loadActiveParticipant().then((next) => {
      setParticipant(next);
      setLoading(false);
    });
    const listener = (next: Participant | null) => setParticipant(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return { participant, loading };
}
