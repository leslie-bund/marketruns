# Live events are topic-filtered, and discovery is a scoped read

Until now MarketDO recorded subscription topics and then ignored them — every event went to every socket — and buyer/seller discovery was client-side filtering over full-market reads, with products resolved one ProductDO call at a time. Two changes landed together under one thread: the live plane stops broadcasting and starts scoping. WebSocket delivery is filtered by topic, and discovery is a scoped server-side read that kills the N+1.

## The topic taxonomy, and fail-open delivery

Topics are `intents`, `intent:<id>`, `product:<id>`, `cart:<id>`, `run:<id>`, and `market`. Delivery is **topic intersection**: an event reaches a socket only when the event's topics meet the socket's. Two deliberate fail-open rules keep the filter from becoming a delivery bug:

- A socket with **no topics is a legacy full-subscribe** — it receives everything, as before.
- An **unclassified event type broadcasts to all** — an event the taxonomy doesn't know yet is delivered, never dropped.

The scope DOs (Cart, Run, Product) are unchanged: their sockets already receive only their own scope, so filtering is a MarketDO fan-out concern, not a per-object one.

## Item-level filtering is deliberately not a topic

Which shop items a seller cares about is **query-side**, expressed through the discovery read — not a subscription topic. The topic space stays small and stable; store vocabulary churn (ADR-0006, including ops moderation) never churns anyone's subscriptions.

## The discovery read

`GET /markets/:market/discovery` scopes by caller:

- **Seller scope** — `?shopItems=…`: only intents matching the store's items, with each intent's products inlined in the same call. The per-intent ProductDO fan-out (the N+1) is gone; products are inlined live from the ProductDOs, so retired products drop out by construction.
- **Buyer scope** — `?buyerId=` or the identity header: only the caller's own intents.
- **Both scopes intersect; scope-less returns empty.** There is no anonymous full-market read on this route.

The mobile seller and buyer hooks consume it: sellers receive only intents for items they listed, buyers only their own.

## The mobile complement

`useLiveEvents` accepts `onReconnect`: every subscription refetches its data on reconnect, so a dropped socket heals itself on return. Polling stays the fallback — liveness is layered, never assumed.

## Consequences

- Fail-open means filtering is about relevance and fan-out, never about withholding: legacy clients and unknown event types still see everything.
- The topic taxonomy is additive; new scopes extend it by the same `scope:<id>` convention.
- Server-side scoping replaces client-side filtering as the doctrine for discovery reads; the wire shrinks as vocabularies and intent volume grow.
