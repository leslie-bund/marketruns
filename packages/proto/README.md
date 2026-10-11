# @market-runs/proto

Zod schemas for every WS/HTTP message in Market Runs — the single wire contract
shared by `apps/edge` (Worker + Durable Objects) and `apps/mobile` (Expo).

- Field and type names follow `GLOSSARY.md` exactly (Intent, Product,
  Negotiation, Cart, Run, Handoff, Settlement, Muster Point, Floor Rate, …).
- All money is integer kobo: `z.number().int().nonnegative()`.
- Vendor-neutral by ADR-0009: payment/KYC messages speak in captures, holds,
  releases, and verifications only — no provider names anywhere.
- Pure: zod only. No platform imports, no server or client code.

`ClientCommandSchema` / `ServerEventSchema` are the discriminated unions for
the two wire directions; `ProductRetiredSchema` / `CartRetiredSchema` double as
the archive-queue payloads the archive consumer persists (ADR-0010).

Every schema exports its inferred TypeScript type alongside it (`z.infer`).

Run tests: `pnpm --filter @market-runs/proto test` (or `npx vitest run` here).
