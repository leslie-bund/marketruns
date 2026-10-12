import { createDatabase, type DatabaseEnv } from "./db.js";
import { parseArchiveMessage } from "./messages.js";

interface Env extends DatabaseEnv {}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const parsed: Array<{ message: Message; value: ReturnType<typeof parseArchiveMessage> extends { data?: infer T } ? T : never }> = [];
    for (const message of batch.messages) {
      const result = parseArchiveMessage(message.body);
      if (!result.success) {
        console.error(JSON.stringify({ event: "archive.dead_letter", messageId: message.id, issues: result.error.issues }));
        message.ack();
        continue;
      }
      parsed.push({ message, value: result.data as never });
    }
    if (parsed.length === 0) return;

    const { db, client } = createDatabase(env);
    try {
      await db.transaction(async (tx) => {
        // Run and settlement row insertion is intentionally handled in queue order;
        // run.retired must precede settlement.released for the FK.
        for (const { message, value } of parsed) {
          try {
            await persistMessage(tx, value as never);
            message.ack();
          } catch (error) {
            console.error(JSON.stringify({ event: "archive.dead_letter", messageId: message.id, error: String(error) }));
            throw error;
          }
        }
      });
    } finally {
      await client.end();
    }
  },
};

async function persistMessage(_tx: unknown, message: never): Promise<void> {
  // Implemented after required durable identities and settlement inputs are
  // present on the retirement payloads.
  console.error(JSON.stringify({ event: "archive.dead_letter", reason: "archive payload lacks required durable references", type: (message as { type?: string }).type }));
}
