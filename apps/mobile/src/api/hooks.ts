import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll a read endpoint while the screen is mounted. The Durable Objects
 * broadcast over WebSockets, while polling is the fallback — refresh errors
 * are surfaced, not swallowed.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 3000): {
  data: T | null;
  error: string | null;
  refreshing: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await loadRef.current();
        if (mounted.current) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busy = false;
        timer = setTimeout(poll, intervalMs);
      }
    };
    void poll();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [intervalMs, tick]);

  return { data, error, refreshing: tick > 0 && data === null, refresh };
}
