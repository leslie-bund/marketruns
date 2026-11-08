import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadAuth({ platform = "ios", secureStore = {}, asyncStorage = {}, fetchImpl } = {}) {
  const source = readFileSync(new URL("../src/api/auth.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const storage = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    ...asyncStorage,
  };
  const secure = {
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
    ...secureStore,
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(id) {
      if (id === "@react-native-async-storage/async-storage") return { __esModule: true, default: storage };
      if (id === "expo-secure-store") return secure;
      if (id === "react") return { useEffect() {}, useState: (value) => [value, () => undefined] };
      if (id === "react-native") return { Platform: { OS: platform } };
      if (id === "./config") return { EDGE_URL: "http://identity.test" };
      throw new Error(`Unexpected auth dependency: ${id}`);
    },
    fetch: fetchImpl ?? (async () => { throw new Error("Unexpected fetch"); }),
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(compiled, context, { filename: "auth.ts" });
  return { auth: module.exports, storage, secure };
}

function successfulFetch(body = { credentialId: "credential:one" }) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

test("native device registration fails closed when SecureStore is unavailable", async () => {
  let insecureWrites = 0;
  let requests = 0;
  const { auth } = loadAuth({
    platform: "ios",
    secureStore: { getItemAsync: async () => { throw new Error("keychain locked"); } },
    asyncStorage: { setItem: async () => { insecureWrites += 1; } },
    fetchImpl: async () => {
      requests += 1;
      return successfulFetch()();
    },
  });

  await assert.rejects(
    auth.registerDeviceKey({ participantId: "participant:one" }),
    (error) => error?.code === "secure-store-unavailable",
  );
  assert.equal(insecureWrites, 0);
  assert.equal(requests, 0);
});

test("native sign-out fails closed and preserves auth state when SecureStore deletion fails", async () => {
  const removed = [];
  const session = { token: "bearer-token", tokenId: "token:one", expiresAt: Date.now() + 60_000 };
  const credential = { participantId: "participant:one", credentialId: "credential:one" };
  const { auth } = loadAuth({
    platform: "android",
    secureStore: { deleteItemAsync: async () => { throw new Error("keystore locked"); } },
    asyncStorage: {
      getItem: async (key) => key === "market-runs:auth-session" ? JSON.stringify(session) : key === "market-runs:device-credential" ? JSON.stringify(credential) : null,
      removeItem: async (key) => { removed.push(key); },
    },
  });
  await auth.loadSession();
  await auth.loadDeviceCredential();

  await assert.rejects(auth.signOut(), (error) => error?.code === "secure-store-unavailable");
  assert.equal(auth.getSession()?.token, "bearer-token");
  assert.equal(auth.getCachedDeviceCredential()?.credentialId, "credential:one");
  assert.deepEqual(removed, []);
});

test("native device authentication never reads the insecure web fallback", async () => {
  let fallbackReads = 0;
  let requests = 0;
  const credential = { participantId: "participant:one", credentialId: "credential:one" };
  const { auth } = loadAuth({
    platform: "ios",
    secureStore: { getItemAsync: async () => { throw new Error("keychain locked"); } },
    asyncStorage: {
      getItem: async (key) => {
        if (key === "market-runs:device-secret-INSECURE-dev-web") fallbackReads += 1;
        return key === "market-runs:device-credential" ? JSON.stringify(credential) : key === "market-runs:device-secret-INSECURE-dev-web" ? "insecure-secret" : null;
      },
    },
    fetchImpl: async () => { requests += 1; return successfulFetch()(); },
  });
  await auth.loadDeviceCredential();

  await assert.rejects(auth.authenticateDeviceKey("participant:one"), (error) => error?.code === "secure-store-unavailable");
  assert.equal(fallbackReads, 0);
  assert.equal(requests, 0);
});

test("web development keeps the flagged AsyncStorage device-secret fallback", async () => {
  let registeredSecret = null;
  const { auth } = loadAuth({
    platform: "web",
    secureStore: { getItemAsync: async () => { throw new Error("unsupported on web"); } },
    asyncStorage: {
      getItem: async (key) => key === "market-runs:device-secret-INSECURE-dev-web" ? "web-dev-secret" : null,
    },
    fetchImpl: async (_url, init) => {
      registeredSecret = JSON.parse(init.body).secret;
      return successfulFetch()();
    },
  });

  await auth.registerDeviceKey({ participantId: "participant:one" });
  assert.equal(registeredSecret, "web-dev-secret");
});

test("successful native sign-out removes device auth and bearer session state", async () => {
  const removed = [];
  let deletedSecret = false;
  const session = { token: "bearer-token", tokenId: "token:one", expiresAt: Date.now() + 60_000 };
  const credential = { participantId: "participant:one", credentialId: "credential:one" };
  const { auth } = loadAuth({
    platform: "android",
    secureStore: { deleteItemAsync: async (key) => { deletedSecret = key === "market-runs.device-secret"; } },
    asyncStorage: {
      getItem: async (key) => key === "market-runs:auth-session" ? JSON.stringify(session) : key === "market-runs:device-credential" ? JSON.stringify(credential) : null,
      removeItem: async (key) => { removed.push(key); },
    },
  });
  await auth.loadSession();
  await auth.loadDeviceCredential();

  await auth.signOut();
  assert.equal(deletedSecret, true);
  assert.equal(auth.getSession(), null);
  assert.equal(auth.getCachedDeviceCredential(), null);
  assert.deepEqual(new Set(removed), new Set(["market-runs:device-credential", "market-runs:auth-session"]));
});
