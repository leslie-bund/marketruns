import { createRequire } from "node:module";

// infra/ has no package.json; resolve the workspace dep from apps/payments.
const require = createRequire(new URL("../apps/payments/package.json", import.meta.url));
const postgres = require("postgres");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required; the Neon connection string is never committed");
const sql = postgres(connectionString, { max: 1, prepare: false });
const markets = [
  { id: "Balogun", name: "Balogun", opensAt: "08:00", closesAt: "18:00" },
  { id: "Computer Village", name: "Computer Village", opensAt: "08:00", closesAt: "19:00" },
];
try {
  for (const market of markets) {
    await sql`
      INSERT INTO markets (id, name, opens_at, closes_at)
      VALUES (${market.id}, ${market.name}, ${market.opensAt}, ${market.closesAt})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, opens_at = EXCLUDED.opens_at,
        closes_at = EXCLUDED.closes_at, updated_at = now()`;
    console.log(`seeded ${market.id}`);
  }
} finally {
  await sql.end();
}
