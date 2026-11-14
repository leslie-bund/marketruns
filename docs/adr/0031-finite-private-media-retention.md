# Finite private media retention

Immediate deletion at Product retirement minimizes R2 storage but destroys useful description/support context before a run's dispute process finishes. Indefinite retention is likewise rejected: it increases cost and cannot satisfy a data-minimisation policy. Retired product and expired intent media therefore become private, finite retained records rather than either disappearing immediately or becoming permanent evidence.

`retained_media` is the durable deletion schedule. Retirement/expiry queue messages carry the capture references; ordinary product/cart history snapshots still omit them. Unaccepted product and expired intent media are deleted after seven days. Sold media receives a 97-day checkout backstop and resets to 90 days from run close, with the archive handling either queue-arrival order. An hourly archive Cron Trigger claims due rows and deletes their private R2 objects; failures return the row to `retained` with an error for a later sweep. An admin hold pauses deletion for a documented incident/legal reason, and release restores the existing deadline.

Capture keys separate `products/captures/`, `intents/captures/`, and `evidence/runs/`. ProductDO no longer deletes bytes synchronously, so retirement does not fail on an R2 delete and media cleanup cannot block the settlement chain. Run handoff/dispute evidence never inherits this schedule. Native R2 lifecycle expiry is not the primary clock because upload-time rules cannot express delivery-relative retention; the database-backed scheduler can. All media remains Standard storage: Infrequent Access's 30-day minimum, transition charges, and retrieval fees are a poor default for seven-day or frequently read objects.

## Consequences

- Product/Intent retirement still deletes live DO state and never resurrects the subject.
- Media metadata remains enumerable for authorised ops through `/ops/api/admin/retained-media`; admin hold/release actions are audited.
- Capture reads remain authenticated and scoped. A retained object is not public and may become unreadable through a retired subject's live read route before its byte-deletion deadline.
- Privacy and operations documentation must state the finite periods and hold process. Counsel may change the periods without changing the retention mechanism.
