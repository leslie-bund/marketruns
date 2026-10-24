import type { Notification } from "@market-runs/proto";

export type DeliveryResult =
  | { kind: "delivered"; providerRef?: string }
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; error: string };

export interface NotificationProviders {
  websocket(notification: Notification): Promise<DeliveryResult>;
  email(notification: Notification): Promise<DeliveryResult>;
}

export interface ProviderOptions {
  resendApiKey?: string | undefined;
  resendFromEmail?: string | undefined;
  identityUrl?: string | undefined;
  identityInternalToken?: string | undefined;
  edgeUrl?: string | undefined;
  edgeInternalToken?: string | undefined;
  fetchImpl?: typeof fetch;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** Resend is used only for receipts/security; marketing and account recovery are intentionally absent. */
export function createProviders(options: ProviderOptions): NotificationProviders {
  const fetcher = options.fetchImpl ?? fetch;
  return {
    async websocket(notification) {
      if (!options.edgeUrl) return { kind: "skipped", error: "EDGE_URL is not configured" };
      try {
        const response = await fetcher(`${options.edgeUrl}/internal/notifications/deliver`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.edgeInternalToken ? { "x-notification-internal": options.edgeInternalToken } : {}),
          },
          body: JSON.stringify(notification),
        });
        // Offline participants are normal: durable API remains authoritative and no retry is needed.
        if (!response.ok) return { kind: "failed", error: `realtime delivery returned ${response.status}` };
        return { kind: "delivered" };
      } catch (error) {
        return { kind: "failed", error: String(error) };
      }
    },
    async email(notification) {
      if (!options.resendApiKey || !options.resendFromEmail || !options.identityUrl) {
        return { kind: "skipped", error: "email provider or identity contact directory is not configured" };
      }
      try {
        const contact = await fetcher(`${options.identityUrl}/internal/notification-contact/${encodeURIComponent(notification.recipientId)}`, {
          headers: options.identityInternalToken ? { "x-identity-internal": options.identityInternalToken } : {},
        });
        if (contact.status === 404) return { kind: "skipped", error: "participant has no verified notification email" };
        if (!contact.ok) return { kind: "retry", error: `contact directory returned ${contact.status}` };
        const body = await contact.json() as { email?: unknown };
        if (typeof body.email !== "string" || !body.email.includes("@")) {
          return { kind: "skipped", error: "participant has no verified notification email" };
        }
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.resendApiKey}`,
            "content-type": "application/json",
            "idempotency-key": notification.dedupeKey,
          },
          body: JSON.stringify({
            from: options.resendFromEmail,
            to: [body.email],
            subject: notification.title,
            text: notification.body,
            html: `<p>${escapeHtml(notification.body)}</p>`,
          }),
        });
        if (response.ok) {
          const receipt = await response.json().catch(() => ({})) as { id?: unknown };
          return { kind: "delivered", ...(typeof receipt.id === "string" ? { providerRef: receipt.id } : {}) };
        }
        const error = `Resend returned ${response.status}`;
        return response.status === 429 || response.status >= 500 ? { kind: "retry", error } : { kind: "failed", error };
      } catch (error) {
        return { kind: "retry", error: String(error) };
      }
    },
  };
}
