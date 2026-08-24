import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  getLoadedProjectFavicon,
  getProjectFaviconGeneration,
  rememberProjectFavicon,
  subscribeProjectFavicons,
} from "@t3tools/client-runtime/state/project-favicon";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { activateCloudRelayAccount, deactivateCloudRelayAccount } from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("does not invalidate icons when no account is active", () => {
    const generation = getProjectFaviconGeneration();

    deactivateCloudRelayAccount();

    expect(getProjectFaviconGeneration()).toBe(generation);
  });

  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    rememberProjectFavicon("account-project", {
      cacheKey: "account-icon",
      src: "/icons/account.svg",
    });
    const sessionsWhenIconsChange: unknown[] = [];
    const unsubscribe = subscribeProjectFavicons("account-project", () => {
      sessionsWhenIconsChange.push(appAtomRegistry.get(managedRelaySessionAtom));
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(getLoadedProjectFavicon("account-project")).toBeNull();
    expect(sessionsWhenIconsChange).toEqual([null]);
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    unsubscribe();
    await cleanup;
  });
});
