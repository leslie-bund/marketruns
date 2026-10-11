# Infrastructure

Provision the Cloudflare resources referenced by the Wrangler configurations before deployment. Store credentials with `wrangler secret put`; never commit `.env`, `.dev.vars`, the Neon connection string, payment credentials, or identity verification credentials. Hyperdrive is configured out of band and must not contain a committed connection string.
