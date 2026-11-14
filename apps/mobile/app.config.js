const appJson = require("./app.json");

const buildProfile = process.env.EAS_BUILD_PROFILE || process.env.APP_ENV || "development";
const requiresBuildEnvironment = buildProfile === "staging" || buildProfile === "production";

function requireBuildValue(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for ${buildProfile} builds; supply it through the build environment.`);
  }
  return value;
}

module.exports = () => {
  const base = appJson.expo;
  if (requiresBuildEnvironment) {
    // Expo inlines EXPO_PUBLIC_EDGE_URL into the application bundle.
    const edgeUrl = requireBuildValue("EXPO_PUBLIC_EDGE_URL");
    if (buildProfile === "staging") {
      let parsedEdgeUrl;
      try {
        parsedEdgeUrl = new URL(edgeUrl);
      } catch {
        throw new Error("EXPO_PUBLIC_EDGE_URL must be a valid non-local HTTPS URL for staging builds.");
      }
      const hostname = parsedEdgeUrl.hostname.toLowerCase();
      const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      const octets = ipv4?.slice(1).map(Number);
      const localIpv4 = octets?.every((octet) => octet >= 0 && octet <= 255) && (
        octets[0] === 0
        || octets[0] === 10
        || octets[0] === 127
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
      );
      const localHostname = hostname === "localhost"
        || hostname.endsWith(".localhost")
        || hostname.endsWith(".local")
        || hostname === "[::1]"
        || /^\[(?:fc|fd|fe80)/.test(hostname)
        || localIpv4;
      if (parsedEdgeUrl.protocol !== "https:" || localHostname) {
        throw new Error("EXPO_PUBLIC_EDGE_URL must be a valid non-local HTTPS URL for staging builds.");
      }

      const flutterwavePublicKey = requireBuildValue("EXPO_PUBLIC_FLW_PUBLIC_KEY");
      if (!flutterwavePublicKey.startsWith("FLWPUBK_TEST-")) {
        throw new Error("EXPO_PUBLIC_FLW_PUBLIC_KEY must use the FLWPUBK_TEST- prefix for staging builds.");
      }
    }
  }
  const googleMapsApiKey = requiresBuildEnvironment
    ? requireBuildValue("GOOGLE_MAPS_API_KEY")
    : process.env.GOOGLE_MAPS_API_KEY?.trim();

  return {
    ...base,
    plugins: [...new Set([...(base.plugins ?? []), "expo-video"])],
    ios: {
      ...base.ios,
      bundleIdentifier: base.ios?.bundleIdentifier || "ng.marketruns.app",
    },
    android: {
      ...base.android,
      package: base.android?.package || "ng.marketruns.app",
      ...(googleMapsApiKey
        ? {
            config: {
              ...base.android?.config,
              googleMaps: {
                ...base.android?.config?.googleMaps,
                apiKey: googleMapsApiKey,
              },
            },
          }
        : {}),
    },
  };
};
