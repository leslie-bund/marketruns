import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { NotificationListResponse } from "@market-runs/proto";
import { listNotifications, markNotificationsRead, useNotificationLive } from "../src/api";
import { Button, Card, Page, Pill, colors, s } from "../src/ui";

const PAGE_SIZE = 25;

export default function NotificationsScreen() {
  const router = useRouter();
  const [state, setState] = useState<NotificationListResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listNotifications({ limit: PAGE_SIZE, offset });
      setState(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [offset]);
  useEffect(() => { void refresh(); }, [refresh]);
  useNotificationLive(() => { void refresh(); });

  const open = async (id: string, deepLink?: string) => {
    setReadError(null);
    try {
      await markNotificationsRead([id]);
      if (deepLink) router.push(deepLink as never);
      else void refresh();
    } catch (reason) {
      setReadError(`Could not mark the notification as read: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  const markLoaded = async () => {
    const ids = (state?.items ?? []).filter((item) => item.readAt === null).map((item) => item.id);
    if (ids.length === 0) return;
    setMarking(true);
    setReadError(null);
    try {
      await markNotificationsRead(ids);
      await refresh();
    } catch (reason) {
      setReadError(`Could not mark loaded notifications as read: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setMarking(false);
    }
  };

  const items = state?.items ?? [];
  const loadedUnread = items.filter((item) => item.readAt === null).length;
  const total = state?.total ?? 0;
  return (
    <Page title="Notifications" eyebrow="Activity" right={<Pill active={(state?.unread ?? 0) > 0}>{state?.unread ?? 0} unread</Pill>}>
      {error ? <Card><Text style={s.body}>{error}</Text><Button title="Retry" onPress={() => void refresh()} /></Card> : null}
      {readError ? <Card><Text style={s.body}>{readError}</Text></Card> : null}
      {loadedUnread > 0 ? <Button title={marking ? "Marking…" : "Mark loaded as read"} secondary onPress={() => void markLoaded()} /> : null}
      {loading && state === null ? <Card><Text style={s.body}>Loading notifications…</Text></Card> : null}
      {state !== null && items.length === 0 && !loading && !error ? <Card><Text style={s.body}>No notifications yet.</Text></Card> : null}
      {items.map((item) => (
        <Pressable key={item.id} onPress={() => void open(item.id, item.deepLink)}>
          <Card>
            <View style={s.row}>
              <Text style={[s.body, { fontWeight: item.readAt === null ? "800" : "600", flex: 1 }]}>{item.title}</Text>
              {item.readAt === null ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.green }} /> : null}
            </View>
            <Text style={s.body}>{item.body}</Text>
            <Text style={s.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
          </Card>
        </Pressable>
      ))}
      {state !== null && total > PAGE_SIZE ? <Card>
        <Text style={s.muted}>Showing {total === 0 ? 0 : offset + 1}–{Math.min(offset + items.length, total)} of {total}</Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {offset > 0 ? <Button title="Previous" secondary onPress={() => setOffset(Math.max(0, offset - PAGE_SIZE))} /> : null}
          {offset + PAGE_SIZE < total ? <Button title="Next" secondary onPress={() => setOffset(offset + PAGE_SIZE)} /> : null}
        </View>
      </Card> : null}
    </Page>
  );
}
