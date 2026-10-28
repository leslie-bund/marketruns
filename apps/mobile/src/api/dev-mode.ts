/** Development-only rehearsal and simulator shortcuts require both switches. */
export function devDemoModeEnabled(devBuild: boolean, explicitFlag: string | undefined): boolean {
  return devBuild && explicitFlag === "true";
}

export const devDemoMode = devDemoModeEnabled(typeof __DEV__ !== "undefined" && __DEV__, process.env.EXPO_PUBLIC_DEMO_MODE);

let rehearsalDepth = 0;

/** Only the explicit /demo route opens this short-lived write exception. */
export async function withDevRehearsal<T>(work: () => Promise<T>): Promise<T> {
  if (!devDemoMode) throw new Error("Dev rehearsal requires __DEV__ and EXPO_PUBLIC_DEMO_MODE=true on an isolated dev backend.");
  rehearsalDepth += 1;
  try {
    return await work();
  } finally {
    rehearsalDepth -= 1;
  }
}

/** Explore remains readable, but anonymous demo identities never write. */
export function assertDemoWriteAllowed(method: string | undefined, hasParticipant: boolean): void {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS" || hasParticipant || rehearsalDepth > 0) return;
  throw new Error("Explore demo is read-only. Onboard to transact, or use the explicit /demo rehearsal on an isolated dev backend.");
}
