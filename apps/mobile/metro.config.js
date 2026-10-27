const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const workspaceSources = [
  path.resolve(__dirname, "../../packages/domain/src") + path.sep,
  path.resolve(__dirname, "../../packages/proto/src") + path.sep,
];
const resolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (workspaceSources.some((source) => context.originModulePath.startsWith(source)) && moduleName.endsWith(".js")) {
    return context.resolveRequest(context, moduleName.slice(0, -3) + ".ts", platform);
  }
  return resolveRequest
    ? resolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
