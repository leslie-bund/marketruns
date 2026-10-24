import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { NotificationListResponse } from "@market-runs/proto";
import { listNotifications, markNotificationsRead, useNotificationLive } from "../src/api";
import { Button, Card, Page, Pill, colors, s } from "../src/ui";

export default function NotificationsScreen() {
  const router = useRouter();
  const [state, setState] = useState<NotificationListResponse>({ items: [], total: 0, unread: 0, limit: 50, offset: 0 });
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void listNotifications().then((next) => { setState(next); setError(null); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  useEffect(refresh, [refresh]);
  useNotificationLive(refresh);

  const open = async (id: string, deepLink?: string) => {
    await markNotificationsRead([id]).catch(() => undefined);
    refresh();
    if (deepLink) router.push(deepLink as never);
  };

  return (
    <Page title="Notifications" eyebrow="Activity" right={<Pill active={state.unread > 0}>{state.unread} unread</Pill>}>
      {error ? <Card><Text style={s.body}>{error}</Text><Button title="Retry" onPress={refresh} /></Card> : null}
      {state.unread > 0 ? <Button title="Mark all as read" secondary onPress={() => {
        const ids = state.items.filter((item) => item.readAt === null).map((item) => item.id);
        if (ids.length > 0) void markNotificationsRead(ids).then(refresh);
      }} /> : null}
      {state.items.length === 0 && !error ? <Card><Text style={s.body}>No notifications yet.</Text></Card> : null}
      {state.items.map((item) => (
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
    </Page>
  );
}
