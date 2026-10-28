import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  NotificationCreatedSchema,
  NotificationListResponseSchema,
  type NotificationListResponse,
  type NotificationMarkReadResponse,
} from "@market-runs/proto";
import { EDGE_URL } from "./config";
import { clearSession, getSession, sessionHeaders } from "./auth";
import { participantHeaders } from "./participant";
import { ApiError } from "./client";

async function notificationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authorization = sessionHeaders();
  const response = await fetch(`${EDGE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authorization, ...participantHeaders(), ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && authorization.authorization) void clearSession();
    throw new ApiError(response.status, String(body.error ?? "unknown"), String(body.message ?? response.statusText));
  }
  return body as T;
}

/** Durable read model; realtime frames only trigger a refresh of this API. */
export async function listNotifications(options: { limit?: number; offset?: number; unreadOnly?: boolean } = {}): Promise<NotificationListResponse> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) });
  if (options.unreadOnly) query.set("unread", "true");
  const body = await notificationRequest<unknown>(`/notifications?${query}`);
  return NotificationListResponseSchema.parse(body);
}

export async function markNotificationsRead(ids: string[]): Promise<NotificationMarkReadResponse> {
  return notificationRequest<NotificationMarkReadResponse>("/notifications/read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

/** Authenticated participant socket. Reconnects always reconcile against durable storage. */
export function useNotificationLive(onChange: () => void): boolean {
  const handler = useRef(onChange);
  handler.current = onChange;
  const session = getSession();
  const token = session?.token;

  useEffect(() => {
    if (!token) return undefined;
    let closed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const connect = () => {
      if (closed) return;
      const base = EDGE_URL.replace(/^http/, "ws");
      socket = new WebSocket(`${base}/notifications/live?access_token=${encodeURIComponent(token)}`);
      socket.onopen = () => {
        attempt = 0;
        handler.current();
      };
      socket.onmessage = (message) => {
        try {
          NotificationCreatedSchema.parse(JSON.parse(String(message.data)));
          handler.current();
        } catch {
          // Invalid frames are ignored; the durable list remains authoritative.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      // Reconcile immediately on foreground return, even before a socket retry fires.
      handler.current();
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        connect();
      }
    });
    return () => {
      closed = true;
      clearTimeout(timer);
      appState.remove();
      socket?.close();
    };
  }, [token]);
  return Boolean(token);
}

/** Navigation badge backed by the same durable centre and reconnecting live socket. */
export function useNotificationSummary(): { unread: number; error: string | null; refresh: () => void } {
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = getSession();
  const token = session?.token;
  const load = useCallback(async () => {
    if (!token) {
      setUnread(0);
      return;
    }
    try {
      const result = await listNotifications({ limit: 1, unreadOnly: true });
      setUnread(result.unread);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useNotificationLive(() => { void load(); });
  return { unread, error, refresh: () => { void load(); } };
}
