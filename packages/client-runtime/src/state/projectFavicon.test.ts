import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  createProjectFaviconSourceAtoms,
  forgetProjectFavicon,
  getLoadedProjectFavicon,
  getProjectFaviconSourceRejectionKey,
  rememberProjectFavicon,
  selectProjectFaviconSources,
  subscribeProjectFavicons,
} from "./projectFavicon.ts";
import { derivePhysicalProjectKey } from "./projectGrouping.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  rootPath: "/work",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

const repositoryGrouping = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function selectSources(
  projects: ReadonlyArray<EnvironmentProject>,
  overrides: Partial<Parameters<typeof selectProjectFaviconSources>[0]> = {},
) {
  return selectProjectFaviconSources({
    projects,
    settings: repositoryGrouping,
    connectedEnvironmentIds: new Set(projects.map((project) => project.environmentId)),
    ...overrides,
  });
}

function makeProject(id: string, overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(`environment-${id}`),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFaviconAtoms(
  projects: ReadonlyArray<EnvironmentProject>,
  accountId: string | null = null,
) {
  const projectsAtom = Atom.make(projects);
  const groupingSettingsAtom = Atom.make(repositoryGrouping);
  const accountSessionAtom = Atom.make<{ readonly accountId: string } | null>(
    accountId ? { accountId } : null,
  );
  const preparedConnectionAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(Option.none<PreparedConnection>()),
  );
  return {
    projectsAtom,
    accountSessionAtom,
    registry: AtomRegistry.make(),
    favicons: createProjectFaviconSourceAtoms({
      projectsAtom,
      groupingSettingsAtom,
      preparedConnectionAtom,
      accountSessionAtom,
      label: "test-project-favicon",
    }),
  };
}

describe("selectProjectFaviconSources", () => {
  it("selects the same source regardless of project order", () => {
    const first = makeProject("first");
    const second = makeProject("second", { updatedAt: "2026-07-02T00:00:00.000Z" });

    for (const projects of [
      [first, second],
      [second, first],
    ]) {
      const sources = selectSources(projects);
      expect(sources.get(derivePhysicalProjectKey(first))).toEqual({
        projectKey: repositoryIdentity.canonicalKey,
        environmentId: first.environmentId,
        cwd: first.workspaceRoot,
        faviconPath: null,
        hasFallback: true,
      });
      expect(sources.get(derivePhysicalProjectKey(second))).toBe(
        sources.get(derivePhysicalProjectKey(first)),
      );
    }
  });

  it("prefers an explicit favicon over a newer automatic favicon", () => {
    const explicit = makeProject("explicit", { faviconPath: "/icons/project.svg" });
    const automatic = makeProject("automatic", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    expect(selectSources([automatic, explicit]).get(derivePhysicalProjectKey(automatic))).toEqual({
      projectKey: repositoryIdentity.canonicalKey,
      environmentId: explicit.environmentId,
      cwd: explicit.workspaceRoot,
      faviconPath: "/icons/project.svg",
      hasFallback: true,
    });
  });

  it("prefers a connected environment over an unavailable custom icon", () => {
    const disconnected = makeProject("disconnected", { faviconPath: "custom.svg" });
    const connected = makeProject("connected");

    expect(
      selectSources([disconnected, connected], {
        connectedEnvironmentIds: new Set([connected.environmentId]),
      }).get(derivePhysicalProjectKey(disconnected))?.environmentId,
    ).toBe(connected.environmentId);
  });

  it("does not retry a project with only one checkout", () => {
    const project = makeProject("single");

    expect(selectSources([project]).get(derivePhysicalProjectKey(project))?.hasFallback).toBe(
      false,
    );
  });

  it("reuses a rejected checkout when it is the only connected source", () => {
    const primary = makeProject("a-primary");
    const backup = makeProject("z-backup");
    const first = selectSources([primary, backup]).get(derivePhysicalProjectKey(primary));

    expect(first?.environmentId).toBe(primary.environmentId);
    expect(first).not.toBeUndefined();
    const recovered = selectSources([primary, backup], {
      connectedEnvironmentIds: new Set([first!.environmentId]),
      rejectedSourceKeys: new Set([getProjectFaviconSourceRejectionKey(first!)]),
    }).get(derivePhysicalProjectKey(primary));

    expect(recovered?.environmentId).toBe(first!.environmentId);
    expect(recovered?.hasFallback).toBe(false);
  });

  it("keeps the same source after an unrelated project update", () => {
    const primary = makeProject("primary");
    const remote = makeProject("remote");

    const before = selectSources([primary, remote]);
    const after = selectSources([
      primary,
      { ...remote, title: "Renamed", updatedAt: "2026-08-01T00:00:00.000Z" },
    ]);

    expect(before.get(derivePhysicalProjectKey(remote))?.environmentId).toBe(primary.environmentId);
    expect(after.get(derivePhysicalProjectKey(remote))?.environmentId).toBe(primary.environmentId);
  });

  it.each(["separate", "repository_path"] as const)(
    "keeps distinct projects isolated in %s grouping",
    (sidebarProjectGroupingMode) => {
      const web = makeProject("web", {
        workspaceRoot: "/work/apps/web",
        faviconPath: "web.svg",
      });
      const mobile = makeProject("mobile", {
        workspaceRoot: "/work/apps/mobile",
        faviconPath: "mobile.svg",
      });
      const sources = selectSources([web, mobile], {
        settings: { ...repositoryGrouping, sidebarProjectGroupingMode },
      });

      expect(sources.get(derivePhysicalProjectKey(web))?.faviconPath).toBe("web.svg");
      expect(sources.get(derivePhysicalProjectKey(mobile))?.faviconPath).toBe("mobile.svg");
    },
  );

  it("respects per-project grouping overrides", () => {
    const separate = makeProject("separate", { faviconPath: "separate.svg" });
    const grouped = makeProject("grouped", { faviconPath: "grouped.svg" });
    const sources = selectSources([separate, grouped], {
      settings: {
        ...repositoryGrouping,
        sidebarProjectGroupingOverrides: {
          [derivePhysicalProjectKey(separate)]: "separate",
        },
      },
    });

    expect(sources.get(derivePhysicalProjectKey(separate))?.faviconPath).toBe("separate.svg");
    expect(sources.get(derivePhysicalProjectKey(grouped))?.faviconPath).toBe("grouped.svg");
  });

  it("uses the newest physical record when an older duplicate still has a cleared icon", () => {
    const cleared = makeProject("current", {
      environmentId: EnvironmentId.make("environment-shared"),
      workspaceRoot: "/work/shared",
      faviconPath: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const stale = makeProject("stale", {
      environmentId: cleared.environmentId,
      workspaceRoot: cleared.workspaceRoot,
      faviconPath: "removed.svg",
    });

    expect(
      selectSources([stale, cleared]).get(derivePhysicalProjectKey(cleared))?.faviconPath,
    ).toBe(null);
  });
});

describe("project favicon source atoms", () => {
  it("preserves a project's selected source when another project changes", () => {
    const selected = makeProject("selected", { repositoryIdentity: null });
    const unrelated = makeProject("unrelated", { repositoryIdentity: null });
    const { projectsAtom, registry, favicons } = makeFaviconAtoms([selected, unrelated]);
    const selectedSourceAtom = favicons.sourceAtom(derivePhysicalProjectKey(selected));
    const firstSource = registry.get(selectedSourceAtom);

    registry.set(projectsAtom, [selected, { ...unrelated, title: "Renamed" }]);

    expect(registry.get(selectedSourceAtom)).toBe(firstSource);
  });

  it("isolates loaded icons when accounts change and restores them for the same account", () => {
    const project = makeProject("account-shared");
    const { accountSessionAtom, registry, favicons } = makeFaviconAtoms([project], "account-first");
    const sourceAtom = favicons.sourceAtom(derivePhysicalProjectKey(project));
    const firstAccountKey = registry.get(sourceAtom).projectKey;
    const favicon = { cacheKey: "account-icon", src: "/icons/account.svg" };
    rememberProjectFavicon(firstAccountKey, favicon);

    registry.set(accountSessionAtom, { accountId: "account-second" });
    const secondAccountKey = registry.get(sourceAtom).projectKey;

    expect(secondAccountKey).not.toBe(firstAccountKey);
    expect(getLoadedProjectFavicon(secondAccountKey)).toBeNull();

    const lateFavicon = { cacheKey: "late-account-icon", src: "/icons/late-account.svg" };
    rememberProjectFavicon(firstAccountKey, lateFavicon);
    expect(getLoadedProjectFavicon(secondAccountKey)).toBeNull();

    registry.set(accountSessionAtom, { accountId: "account-first" });

    expect(registry.get(sourceAtom).projectKey).toBe(firstAccountKey);
    expect(getLoadedProjectFavicon(firstAccountKey)).toEqual(lateFavicon);
    forgetProjectFavicon(firstAccountKey);
  });

  it("keeps fallback project keys account-scoped before project records load", () => {
    const physicalProjectKey = "environment-shared:/work/shared";
    const { accountSessionAtom, registry, favicons } = makeFaviconAtoms([], "account-first");
    const sourceAtom = favicons.sourceAtom(physicalProjectKey);

    expect(registry.get(sourceAtom)).toEqual({
      projectKey: `account-first:${physicalProjectKey}`,
      source: null,
    });

    registry.set(accountSessionAtom, { accountId: "account-second" });

    expect(registry.get(sourceAtom)).toEqual({
      projectKey: `account-second:${physicalProjectKey}`,
      source: null,
    });
  });

  it("tries another connected checkout after the selected source has no icon", () => {
    const missing = makeProject("a-missing");
    const available = makeProject("z-available");
    const { registry, favicons } = makeFaviconAtoms([missing, available]);
    const sourceAtom = favicons.sourceAtom(derivePhysicalProjectKey(missing));
    const first = registry.get(sourceAtom).source;

    expect(first?.environmentId).toBe(missing.environmentId);
    expect(first).not.toBeNull();
    registry.update(favicons.rejectedSourcesAtom, (current) =>
      new Set(current).add(getProjectFaviconSourceRejectionKey(first!)),
    );

    expect(registry.get(sourceAtom).source?.environmentId).toBe(available.environmentId);
  });
});

describe("loaded project favicons", () => {
  it("returns null when a favicon has not loaded", () => {
    expect(getLoadedProjectFavicon("missing-project")).toBeNull();
  });

  it("ignores stale image errors when a newer image has loaded", () => {
    const projectKey = "conditional-forget-project";
    const favicon = { cacheKey: "revision-two", src: "/icons/two.svg" };
    rememberProjectFavicon(projectKey, favicon);

    forgetProjectFavicon(projectKey, "/icons/one.svg");
    expect(getLoadedProjectFavicon(projectKey)).toEqual(favicon);

    forgetProjectFavicon(projectKey, favicon.src);
    expect(getLoadedProjectFavicon(projectKey)).toBeNull();
  });

  it("notifies subscribers only when the stored favicon changes", () => {
    const projectKey = "subscription-project";
    const favicon = { cacheKey: "revision-one", src: "/icons/one.svg" };
    const listener = vi.fn();
    const unsubscribe = subscribeProjectFavicons(projectKey, listener);

    rememberProjectFavicon(projectKey, favicon);
    rememberProjectFavicon(projectKey, { ...favicon });
    forgetProjectFavicon(projectKey, "/icons/old.svg");
    rememberProjectFavicon("unrelated-project", favicon);

    expect(listener).toHaveBeenCalledTimes(1);

    forgetProjectFavicon(projectKey);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    rememberProjectFavicon(projectKey, favicon);
    expect(listener).toHaveBeenCalledTimes(2);
    forgetProjectFavicon(projectKey);
    forgetProjectFavicon("unrelated-project");
  });

  it("evicts the oldest favicon after the cache reaches its limit", () => {
    const oldestProjectKey = "bounded-project-0";
    const oldestProjectListener = vi.fn();
    const unsubscribe = subscribeProjectFavicons(oldestProjectKey, oldestProjectListener);

    for (let index = 0; index <= 256; index++) {
      rememberProjectFavicon(`bounded-project-${index}`, {
        cacheKey: `revision-${index}`,
        src: `/icons/${index}.svg`,
      });
    }

    expect(getLoadedProjectFavicon(oldestProjectKey)).toBeNull();
    expect(getLoadedProjectFavicon("bounded-project-256")).toEqual({
      cacheKey: "revision-256",
      src: "/icons/256.svg",
    });
    expect(oldestProjectListener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
