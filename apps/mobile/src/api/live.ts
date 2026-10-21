import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@market-runs/proto";
import { EDGE_URL } from "./config";

/**
 * Subscribe to a scope's live events over WebSocket. Every Durable Object
 * broadcasts its events to attached sockets (hibernation keeps them cheap),
 * but polling clients never see them — this hook is the fast path: each event
 * triggers `onEvent` (typically the poll's refresh), while slow polling stays
 * as the fallback. Reconnects with backoff while mounted.
 *
 * `onReconnect` fires on every successful open AFTER the first: events that
 * aired while the socket was down are lost, so the subscriber refetches
 * immediately instead of sitting stale until the next poll. Refetches dedupe
 * against an in-flight poll via `usePoll`'s busy guard.
 *
 * `path` is a scope path like `/products/<id>`, `/carts/<id>`, `/runs/<id>` —
 * the edge forwards the upgrade straight to the owning DO.
 *
 * `topics` (optional) declares the event classes this socket wants (the
 * taxonomy lives with the server's topic-filtered broadcast): the socket then
 * receives only matching events, re-declared on every (re)connect and
 * whenever the topics change while mounted. Omitting topics keeps the legacy
 * full-subscribe — every event on the scope arrives.
 */
export function useLiveEvents(
  path: string | null,
  onEvent: (event: ServerEvent) => void,
  onReconnect?: () => void,
  topics?: string[],
): boolean {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const socketRef = useRef<WebSocket | null>(null);
  // Topic arrays are rebuilt every render; the joined key is the real identity.
  const topicsKey = (topics ?? []).join(" ");

  useEffect(() => {
    if (!path) return undefined;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let everConnected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(`${EDGE_URL.replace(/^http/, "ws")}${path}`);
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        const topics = topicsRef.current;
        if (topics && topics.length > 0 && socket) {
          socket.send(JSON.stringify({ type: "subscribe", topics }));
        }
        // A reconnect means a gap in the event stream: refetch now.
        if (everConnected) reconnectRef.current?.();
        everConnected = true;
      };
      socket.onmessage = (message) => {
        try {
          handlerRef.current(JSON.parse(String(message.data)) as ServerEvent);
        } catch {
          // Malformed frame — ignore; polling keeps the screen honest.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
      };
      socket.onerror = () => socket?.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      setConnected(false);
      socketRef.current = null;
      socket?.close();
    };
  }, [path]);

  // Topics changed while the socket was up (e.g. the buyer posted another
  // intent): re-declare them on the live socket without reconnecting.
  useEffect(() => {
    const socket = socketRef.current;
    const topics = topicsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && topics && topics.length > 0) {
      socket.send(JSON.stringify({ type: "subscribe", topics }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey, connected]);

  return connected;
}
