import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

const LINUX_PROVIDER_USER_BIN_SUFFIXES = [".local/bin", ".grok/bin", ".opencode/bin"] as const;

export function ensureLinuxProviderUserBins(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "linux") {
    return environment;
  }

  const home = environment.HOME?.trim();
  if (!home) {
    return environment;
  }

  const inheritedPath = environment.PATH ?? "";
  const pathEntries = inheritedPath.split(":").filter((entry) => entry.length > 0);
  const userBins = LINUX_PROVIDER_USER_BIN_SUFFIXES.map(
    (suffix) => `${home.replace(/\/$/, "")}/${suffix}`,
  );
  const nextPath = [
    ...userBins.filter((entry) => !pathEntries.includes(entry)),
    ...pathEntries,
  ].join(":");

  if (nextPath === inheritedPath) {
    return environment;
  }
  return { ...environment, PATH: nextPath };
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    next[variable.name] = variable.value;
  }
  return ensureLinuxProviderUserBins(next, platform);
}
