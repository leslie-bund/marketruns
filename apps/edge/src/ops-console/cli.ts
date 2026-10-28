import { count, eq, sql } from "drizzle-orm";
import { markets, opsUsers } from "../../../../infra/drizzle/schema.js";
import type { Env } from "../config/env.js";
import { createOpsAuth } from "./auth.js";
import { createOpsDatabase } from "./db.js";
import { resolveMarketSeeds } from "./market-seeds.js";

/** Run with tsx; secrets arrive only through argv/environment, never source. */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const env = process.env as unknown as Env & { OPS_REQUIRE_PASSWORD_CHANGE?: string };
  const { db, client } = createOpsDatabase(env);
  try {
    if (command === "bootstrap-admin") {
      const email = value(args, "--email");
      const password = value(args, "--password");
      const name = option(args, "--name") ?? "Pilot administrator";
      if (!email || !password) throw new Error("usage: bootstrap-admin --email EMAIL --password PASSWORD [--name NAME]");
      if (password.length < 12) throw new Error("password must contain at least 12 characters");
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(741852963)`);
        const [existing] = await tx.select({ value: count() }).from(opsUsers);
        if ((existing?.value ?? 0) > 0) throw new Error("an operator already exists; first-admin bootstrap is closed");
        const auth = createOpsAuth(env, tx as unknown as typeof db, { bootstrap: true });
        const result = await auth.api.signUpEmail({ body: { email, password, name } });
        if (!result.user) throw new Error("Better Auth did not create the administrator");
        await tx.update(opsUsers).set({
          role: "admin",
          mustChangePassword: env.OPS_REQUIRE_PASSWORD_CHANGE !== "false",
          updatedAt: new Date(),
        }).where(eq(opsUsers.id, result.user.id));
      });
      console.log(`Created first ops administrator ${email}. No password was printed or stored in source.`);
      return;
    }
    if (command === "seed-markets") {
      for (const seed of resolveMarketSeeds(args, Date.now())) {
        await db.insert(markets).values({
          id: seed.id, name: seed.name, opensAt: seed.opensAt, closesAt: seed.closesAt, config: seed.config,
          centerLatitude: seed.center.latitude, centerLongitude: seed.center.longitude, geofenceRadiusMeters: seed.radiusMeters,
        }).onConflictDoUpdate({ target: markets.id, set: {
          name: seed.name, opensAt: seed.opensAt, closesAt: seed.closesAt,
          centerLatitude: seed.center.latitude, centerLongitude: seed.center.longitude,
          geofenceRadiusMeters: seed.radiusMeters, updatedAt: new Date(),
        } });
        console.log(`Seeded market ${seed.name} at ${seed.center.latitude},${seed.center.longitude} (${seed.radiusMeters} m)`);
      }
      return;
    }
    throw new Error("usage: bootstrap-admin --email EMAIL --password PASSWORD | seed-markets [MARKET ...] | seed-markets MARKET --latitude LAT --longitude LNG --radius-meters METERS");
  } finally {
    await client.end();
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function value(args: string[], name: string): string | undefined {
  const result = option(args, name);
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

await main();
