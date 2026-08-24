import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  getLoadedProjectFavicon,
  getProjectFaviconGeneration,
  rememberProjectFavicon,
  subscribeProjectFavicons,
} from "@t3tools/client-runtime/state/project-favicon";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  readManagedRelayClerkToken,
} from "./managedAuth";

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
});

describe("managed relay authentication", () => {
  it("does not invalidate icons when no account is active", () => {
    const generation = getProjectFaviconGeneration();

    deactivateManagedRelayAuthentication();

    expect(getProjectFaviconGeneration()).toBe(generation);
  });

  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    rememberProjectFavicon("account-project", {
      cacheKey: "account-icon",
      src: "/icons/account.svg",
    });
    const sessionsWhenIconsChange: unknown[] = [];
    const unsubscribe = subscribeProjectFavicons("account-project", () => {
      sessionsWhenIconsChange.push(appAtomRegistry.get(managedRelaySessionAtom));
    });
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(await readManagedRelayClerkToken()).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(getLoadedProjectFavicon("account-project")).toBeNull();
    expect(sessionsWhenIconsChange).toEqual([null]);
    expect(await readManagedRelayClerkToken()).toBeNull();
    unsubscribe();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});
