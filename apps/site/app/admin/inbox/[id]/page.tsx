import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReplyComposer } from "../../../../components/reply-composer";
import { listInboundAttachments } from "../../../../src/attachments";
import { getInboundEmail, listEmailReplies } from "../../../../src/db";
import { requireAdmin } from "../../../../src/server";
import styles from "../inbox.module.css";
import { formatDate, PortalShell, receivedAddresses } from "../portal";

export const metadata: Metadata = { title: "Inbox conversation" };
export const dynamic = "force-dynamic";

const htmlEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return htmlEntities[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(value: string) {
  return decodeEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageBody(textBody: string | null, htmlBody: string | null) {
  if (textBody?.trim()) return textBody;
  if (htmlBody?.trim()) return htmlToText(htmlBody) || "This message has no readable body.";
  return "This message did not include a message body.";
}

function prettyRawPayload(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function InboxConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ env, site, user }, { id }] = await Promise.all([requireAdmin(), params]);
  const email = await getInboundEmail(site, id);
  if (!email) notFound();
  const [replies, attachments] = await Promise.all([
    listEmailReplies(site, id),
    listInboundAttachments(env, email.resend_email_id),
  ]);
  const recipients = receivedAddresses(email.to_addresses);

  return (
    <PortalShell email={user.email}>
      <section className={styles.content} aria-labelledby="conversation-title">
        <Link className={styles.backLink} href="/admin/inbox">
          <span aria-hidden="true">←</span> Back to inbox
        </Link>
        <div className={styles.conversationHeader}>
          <p className={styles.eyebrow}>Conversation</p>
          <h1 id="conversation-title">{email.subject.trim() || "(No subject)"}</h1>
          <dl className={styles.messageMeta}>
            <div className={styles.metaGroup}>
              <dt>From</dt>
              <dd>{email.from_address || "Unknown sender"}</dd>
            </div>
            <div className={styles.metaGroup}>
              <dt>To</dt>
              <dd>{recipients}</dd>
            </div>
            <div className={styles.metaGroup}>
              <dt>Received</dt>
              <dd><time dateTime={email.received_at}>{formatDate(email.received_at)}</time></dd>
            </div>
          </dl>
        </div>

        <ol className={styles.thread} aria-label="Email thread">
          <li className={styles.threadItem}>
            <article className={styles.message}>
              <header className={styles.messageHeader}>
                <div>
                  <h2>{email.from_address || "Unknown sender"}</h2>
                  <p>To {recipients}</p>
                </div>
                <div className={styles.messageTiming}>
                  <span className={`${styles.badge} ${styles.received}`}>Received</span>
                  <time dateTime={email.received_at}>{formatDate(email.received_at)}</time>
                </div>
              </header>
              <pre className={styles.messageBody}>{messageBody(email.text_body, email.html_body)}</pre>
              {attachments === null ? (
                <p className={styles.attachmentsUnavailable}>
                  Attachments could not be loaded. Refresh the conversation to try again.
                </p>
              ) : attachments.length > 0 ? (
                <section className={styles.attachments} aria-labelledby={`attachments-${email.id}`}>
                  <h3 id={`attachments-${email.id}`}>Attachments ({attachments.length})</h3>
                  <ul>
                    {attachments.map((attachment) => {
                      const filename = attachment.filename?.trim() || "Untitled attachment";
                      return (
                        <li key={attachment.id}>
                          <a
                            className={styles.attachmentLink}
                            href={`/api/admin/inbox/${encodeURIComponent(email.id)}/attachments/${encodeURIComponent(attachment.id)}`}
                            download={filename}
                          >
                            <span className={styles.attachmentInfo}>
                              <span className={styles.attachmentName}>{filename}</span>
                              <span className={styles.attachmentMeta}>
                                {formatAttachmentSize(attachment.size)} · {attachment.content_type}
                              </span>
                            </span>
                            <span className={styles.attachmentDownload}>Download</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </article>
          </li>
          {replies.map((reply) => (
            <li className={styles.threadItem} key={reply.id}>
              <article className={`${styles.message} ${styles.reply}`}>
                <header className={styles.messageHeader}>
                  <div>
                    <h2>You replied</h2>
                    <p>To {reply.to_address}</p>
                  </div>
                  <div className={styles.messageTiming}>
                    <span className={`${styles.badge} ${reply.status === "sent" ? styles.sent : styles.failed}`}>
                      {reply.status === "sent" ? "Sent" : "Delivery failed"}
                    </span>
                    <time dateTime={reply.created_at}>{formatDate(reply.created_at)}</time>
                  </div>
                </header>
                <pre className={styles.messageBody}>{reply.text_body}</pre>
              </article>
            </li>
          ))}
        </ol>

        <details className={styles.rawDetails}>
          <summary>View original event payload</summary>
          <pre className={styles.rawPayload}>{prettyRawPayload(email.raw_payload)}</pre>
        </details>

        <ReplyComposer inboundEmailId={email.id} recipient={email.from_address} />
      </section>
    </PortalShell>
  );
}
