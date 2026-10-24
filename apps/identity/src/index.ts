import { createDatabase } from "./db.js";
import type { Env } from "./env.js";
import { RequestIdSchema } from "@market-runs/proto";
import { createIdentityApp } from "./app.js";
import { createFaceVerifier, createLocalFaceVerifier } from "./face-verifier.js";
import { createPasskeyVerifier } from "./passkey-verifier.js";
import { createDrizzleStore } from "./store.js";

/**
 * The identity worker: owns all credential/biometric state (face enrollment +
 * verification, device credentials, sessions, device resets) in Postgres —
 * the system of record (ADR-0011). The edge NEVER touches this database; it
 * proxies /auth/* here (IDENTITY_URL) exactly the way the ops console proxies
 * reach the archive (OPS_ARCHIVE_URL pattern).
 *
 * Per-request connection lifecycle mirrors apps/archive (postgres-js max: 1,
 * closed in finally) — Worker isolates are short-lived.
 */

/**
 * Request correlation (x-request-id): honor a well-formed inbound id, else
 * generate one; echo it on the response and emit one parseable log line per
 * request — { requestId, method, path, status, ms }. Cheap, no bodies.
 */
function resolveRequestId(header: string | null): string {
  return header !== null && RequestIdSchema.safeParse(header).success ? header : crypto.randomUUID();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    let status = 500;
    try {
      const url = new URL(request.url);
      let response: Response;
      // Health check must not require the database.
      if (request.method === "GET" && url.pathname === "/healthz") {
        response = Response.json({ ok: true, service: "market-runs-identity" });
      } else {
        const { db, client } = createDatabase(env);
        try {
          const app = createIdentityApp({
            store: createDrizzleStore(db),
            faceVerifier: createFaceVerifier(env),
            localFaceVerifier: createLocalFaceVerifier(env),
            passkeyVerifier: createPasskeyVerifier(env),
          });
          response = await app.fetch(request, env);
        } finally {
          await client.end();
        }
      }
      status = response.status;
      try {
        response.headers.set("x-request-id", requestId);
      } catch {
        /* immutable headers — skip the echo, keep the log line */
      }
      return response;
    } finally {
      console.log(
        JSON.stringify({
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          status,
          ms: Date.now() - started,
        }),
      );
    }
  },
};
