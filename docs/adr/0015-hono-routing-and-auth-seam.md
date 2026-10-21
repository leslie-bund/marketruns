# Hono routing, a readable edge structure, and the authentication seam

The edge worker outgrew its hand-rolled routing: URL dispatch was `if/else`
over path segments, protocol helpers, internal schemas, and the ops console
lived in five flat files, and — more importantly — there was no place where
authentication and authorisation were even *expressed*. This ADR records the
restructure and the deliberate decision about an auth framework.

## Hono, and how auth flows now

Routing is Hono: explicit route tables per scope (`app/routes/`), with the
app assembled in one place (`app/app.ts`) that reads top to bottom:

```ts
app.use("*", participant());        // who is calling
app.route("/command", commandRoute());
app.route("/markets", marketsRoute());
...
ops.use("/api/*", requireOps());    // the only authorisation gate today
```

Identity enters through **one middleware seam**
(`app/middleware/participant.ts`). It resolves a `Participant` (id + role +
source) per request, role guards read it, and `/command` adopts the
authenticated caller's id for `buyerId` when the wire omits it — so the
durable record is attributed through the auth layer rather than purely by
client claim. When real authentication lands, **only `resolveParticipant`
changes**; routes and guards stay as they are. *[Amended: real auth landed
partially in ADR-0022 — `resolveParticipant` now also verifies
`Authorization: Bearer` sessions from `apps/identity` locally (source
`"session"`); header mode is retained for dev, and no route or guard
changed.]*

Resolution is deliberately dev-stage: `x-participant-id` / `x-participant-role`
headers are trusted (a client proxy sets them after verifying its own
session), else the caller is anonymous and the wire behaves exactly as
before. *[Amended: the header identity is now load-bearing — cart/run
keying, dispute attribution, and runner run discovery resolve through it,
not just as a fallback (ADR-0018).]* The ops console API is guarded by `requireOps`: deployed environments
set the `OPS_TOKEN` secret and adjustments require it as `x-ops-token`; local
dev leaves it unset and the guard admits a clearly labelled `local-ops`
operator so the console works out of the box.

## Why not better-auth (yet)

better-auth was evaluated and deferred. It wants to own `user`/`session`/
`account` tables in the database — but whether participants are anchored in
Postgres at all is an open founder decision (schema README), session issuance
will eventually sit beside KYC verification (ADR-0004/0009), and the
marketplace needs role claims, not just accounts. Adopting it now would
pre-decide the schema question its way. The middleware seam above is the
integration point: swapping in better-auth (or a session service or KYC-vendor
assertions) replaces one function.

## Structure

`apps/edge/src` is grouped by category, each folder a barrel:

```
app/            Hono app: routes/, middleware/ — the request layer
ops-console/    the embedded console (html, handlers)
do/             the four Durable Objects + their runtime library
  run/          RunDO split: run-do.ts, settlement.ts (pure), state.ts
  runtime/      DO runtime library barrel: responses, wire, internal-parse, ws
  schemas.ts    internal DO-to-DO request/response shapes
  transport.ts  internalPost / fetchInternal
config/         env.ts (bindings + OPS_TOKEN), ids.ts
```

Nothing moved between Durable Objects; this is a file-level reorganisation
plus the routing swap. The existing e2e suite passes unchanged against the
Hono app; new tests cover the WebSocket gateway through the app (the 101
pass-through) and the auth seam (header adoption, the `requireOps` branches).

## Consequences

- Every route's auth requirement is one visible line next to the route table.
- The trailing-slash normalisation the old dispatcher did globally is gone;
  DOs already normalise their own paths, and no client used it.
- When better-auth (or any identity layer) is chosen, the change surface is
  `resolveParticipant` plus participant provisioning — recorded here so that
  decision is made once, deliberately.
