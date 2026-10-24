import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ServerEvent } from "@market-runs/proto";
import { EDGE_URL } from "./config";
import { sessionHeaders } from "./auth";
import { participantHeaders } from "./participant";

export interface LiveEventOptions {
  /** Session-authenticated sellers attach their owned store to the market socket. */
  storeId?: string;
  /** Send explicit foreground presence heartbeats (seller market sockets only). */
  heartbeat?: boolean;
}

type ReactNativeWebSocket = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

/** React Native supports auth headers on WebSocket; browser dev simply ignores the extra option. */
function openSocket(url: string): WebSocket {
  const Socket = WebSocket as ReactNativeWebSocket;
  return new Socket(url, undefined, { headers: { ...sessionHeaders(), ...participantHeaders() } });
}

/**
 * Subscribe to a scope's live events over WebSocket. Slow polling remains the
 * fallback. Reconnects and foreground returns reconcile immediately because
 * events aired while disconnected are not replayed.
 */
export function useLiveEvents(
  path: string | null,
  onEvent: (event: ServerEvent) => void,
  onReconnect?: () => void,
  topics?: string[],
  options: LiveEventOptions = {},
): boolean {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const socketRef = useRef<WebSocket | null>(null);
  const topicsKey = (topics ?? []).join(" ");
  const storeId = options.storeId;
  const heartbeat = options.heartbeat ?? false;

  useEffect(() => {
    if (!path) return undefined;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let everConnected = false;
    let foreground = AppState.currentState === "active";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sendHeartbeat = () => {
      if (heartbeat && foreground && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "heartbeat", foreground: true }));
      }
    };
    const connect = () => {
      if (closed) return;
      const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      socket = openSocket(`${EDGE_URL.replace(/^http/, "ws")}${path}${query}`);
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        const currentTopics = topicsRef.current;
        if (currentTopics && currentTopics.length > 0 && socket) {
          socket.send(JSON.stringify({ type: "subscribe", topics: currentTopics }));
        }
        sendHeartbeat();
        if (everConnected) reconnectRef.current?.();
        everConnected = true;
      };
      socket.onmessage = (message) => {
        try {
          handlerRef.current(JSON.parse(String(message.data)) as ServerEvent);
        } catch {
          // Presence acknowledgements and malformed frames need no event handling.
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

    const heartbeatTimer = heartbeat ? setInterval(sendHeartbeat, 30_000) : undefined;
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        foreground = false;
        return;
      }
      if (foreground) return;
      foreground = true;
      reconnectRef.current?.();
      if (socket?.readyState === WebSocket.OPEN) sendHeartbeat();
      else if (!socket || socket.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        connect();
      }
    });

    return () => {
      closed = true;
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      appState.remove();
      setConnected(false);
      socketRef.current = null;
      socket?.close();
    };
  }, [path, storeId, heartbeat]);

  useEffect(() => {
    const socket = socketRef.current;
    const currentTopics = topicsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && currentTopics && currentTopics.length > 0) {
      socket.send(JSON.stringify({ type: "subscribe", topics: currentTopics }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey, connected]);

  return connected;
}
