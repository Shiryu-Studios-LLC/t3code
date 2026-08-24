import type { EffectCallback, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

const GROUP_KEY = "repository:mobile-favicon-tests";
const SOURCE_ENVIRONMENT = "environment-source" as EnvironmentId;
const SOURCE_ROOT = "/workspace/source";

const testState = vi.hoisted(() => ({
  accountId: null as string | null,
  assetStatus: "Success" as "Failure" | "Loading" | "Success",
  faviconUrl: "https://environment.test/api/assets/token-a/v1-favicon.svg",
  sources: new Map<
    string,
    {
      readonly projectKey: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly faviconPath?: string | null;
    }
  >(),
}));

const hooks = vi.hoisted(() => {
  let cleanups: Array<() => void> = [];

  return {
    reset() {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
    },
    useLayoutEffect(effect: EffectCallback) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: EffectCallback) => effect(),
    useLayoutEffect: hooks.useLayoutEffect,
    useMemo: <T,>(factory: () => T) => factory(),
    useSyncExternalStore: (
      _subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: (size: number) => Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
}));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("./AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#fff" }));
vi.mock("../state/projects", () => ({
  projectFavicons: { sourceAtom: (physicalProjectKey: string) => physicalProjectKey },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (physicalProjectKey: string) => {
    const source = testState.sources.get(physicalProjectKey) ?? null;
    return {
      source,
      projectKey:
        source?.projectKey ??
        (testState.accountId ? `${testState.accountId}:${physicalProjectKey}` : physicalProjectKey),
    };
  },
}));
vi.mock("../state/assets", () => ({
  useAssetUrlState: () =>
    testState.assetStatus === "Success"
      ? { _tag: "Success", url: testState.faviconUrl }
      : { _tag: testState.assetStatus },
}));

import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
} from "@t3tools/client-runtime/state/project-favicon";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import { ProjectFavicon } from "./ProjectFavicon";

type ImageElement = ReactElement<{
  readonly source: { readonly uri: string; readonly cacheKey: string };
  readonly onLoad: () => void;
  readonly onError: () => void;
}>;

type FaviconImageProps = {
  readonly projectKey: string;
  readonly cacheKey: string | null;
  readonly loadedFavicon: { readonly cacheKey: string; readonly src: string } | null;
};

type FaviconImageElement = ReactElement<{
  readonly children: readonly [ReactElement | null, ReadonlyArray<ImageElement | null>];
}>;

function renderFavicon(environmentId: EnvironmentId, workspaceRoot: string) {
  return ProjectFavicon({
    environmentId,
    workspaceRoot,
    projectTitle: "Project",
  }) as ReactElement<FaviconImageProps>;
}

function renderImage(element: ReactElement<FaviconImageProps>): FaviconImageElement {
  const Component = element.type as (props: FaviconImageProps) => FaviconImageElement;
  return Component(element.props);
}

function loadGroupFavicon() {
  const loading = renderFavicon(SOURCE_ENVIRONMENT, SOURCE_ROOT);
  renderImage(loading).props.children[1][1]?.props.onLoad();
  return loading;
}

beforeEach(() => {
  hooks.reset();
  testState.accountId = null;
  testState.assetStatus = "Success";
  testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-favicon.svg";
  testState.sources.clear();
  testState.sources.set(derivePhysicalProjectKeyFromPath(SOURCE_ENVIRONMENT, SOURCE_ROOT), {
    projectKey: GROUP_KEY,
    environmentId: SOURCE_ENVIRONMENT,
    cwd: SOURCE_ROOT,
  });
  forgetProjectFavicon(GROUP_KEY);
});

afterEach(() => {
  hooks.reset();
  forgetProjectFavicon(GROUP_KEY);
  forgetProjectFavicon("account-current:environment-test:/workspace-test");
});

describe("ProjectFavicon", () => {
  it("keeps a loaded group favicon visible after its environment disconnects", () => {
    const loading = loadGroupFavicon();

    expect(getLoadedProjectFavicon(GROUP_KEY)?.src).toBe(testState.faviconUrl);

    testState.assetStatus = "Loading";
    const disconnected = renderFavicon(SOURCE_ENVIRONMENT, SOURCE_ROOT);
    const displayedImage = renderImage(disconnected).props.children[1][0];

    expect(displayedImage?.props.source.uri).toBe(testState.faviconUrl);
    expect(disconnected.props.loadedFavicon?.cacheKey).toBe(loading.props.cacheKey);
  });

  it("keeps a loaded favicon when a different group source has no icon", () => {
    loadGroupFavicon();
    const loadedUrl = testState.faviconUrl;

    testState.sources.set(derivePhysicalProjectKeyFromPath(SOURCE_ENVIRONMENT, SOURCE_ROOT), {
      projectKey: GROUP_KEY,
      environmentId: "environment-missing" as EnvironmentId,
      cwd: "/workspace/missing",
    });
    testState.faviconUrl =
      "https://environment.test/api/assets/token-missing/project-favicon-missing";

    const missing = renderFavicon(SOURCE_ENVIRONMENT, SOURCE_ROOT);
    const displayedImage = renderImage(missing).props.children[1][0];

    expect(displayedImage?.props.source.uri).toBe(loadedUrl);
    expect(getLoadedProjectFavicon(GROUP_KEY)?.src).toBe(loadedUrl);
  });

  it("scopes a missing project selection to the current account", () => {
    testState.accountId = "account-current";

    const favicon = renderFavicon("environment-test" as EnvironmentId, "/workspace-test");

    expect(favicon.props.projectKey).toBe("account-current:environment-test:/workspace-test");
  });
});
