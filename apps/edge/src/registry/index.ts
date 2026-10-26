import type { Env } from "../config/env.js";
import { MemoryCoreRegistry } from "./memory.js";
import { PostgresCoreRegistry } from "./postgres.js";
import type { CoreRegistry } from "./types.js";

export function headerAuthAllowed(env: Pick<Env, "ALLOW_HEADER_AUTH">): boolean {
  return env.ALLOW_HEADER_AUTH === "true";
}

const clients = new Map<string, CoreRegistry>();

/** Production requires Postgres; the in-memory adapter exists only in explicit dev/test posture. */
export function coreRegistry(env: Env): CoreRegistry {
  const connectionString = env.DATABASE_URL || env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    if (headerAuthAllowed(env)) return new MemoryCoreRegistry();
    throw new Error("DATABASE_URL or HYPERDRIVE is required for the durable core registry");
  }
  let registry = clients.get(connectionString);
  if (!registry) {
    registry = new PostgresCoreRegistry(connectionString);
    clients.set(connectionString, registry);
  }
  return registry;
}

export function canTransact(kycStatus: string, explicitStaging = false): boolean {
  return kycStatus === "verified" || (explicitStaging && kycStatus === "preverified");
}

export * from "./types.js";
