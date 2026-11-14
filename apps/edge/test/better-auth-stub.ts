// The legacy ops workerd suite does not exercise Better Auth. Keeping the
// third-party Node-oriented auth graph out of this suite avoids conflating DO
// behavior with auth-adapter loading; auth gets its own deployed-stack test.
export function betterAuth() {
  throw new Error("Better Auth is not available in the legacy workerd test stub");
}

export function drizzleAdapter() {
  throw new Error("Better Auth is not available in the legacy workerd test stub");
}

export function admin() {
  return { id: "admin" };
}

export function magicLink() {
  return { id: "magic-link" };
}
