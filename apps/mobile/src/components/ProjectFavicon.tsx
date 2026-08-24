import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
  getProjectFaviconSourceRejectionKey,
  rememberProjectFavicon,
  subscribeProjectFavicons,
} from "@t3tools/client-runtime/state/project-favicon";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrlState } from "../state/assets";
import { projectFavicons } from "../state/projects";
import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  isCurrentProjectFaviconRequest,
} from "./projectFaviconCache";

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
}) {
  const size = props.size ?? 42;
  const physicalProjectKey = props.workspaceRoot
    ? derivePhysicalProjectKeyFromPath(props.environmentId, props.workspaceRoot)
    : null;
  const selection = useAtomValue(projectFavicons.sourceAtom(physicalProjectKey ?? ""));
  const rejectSources = useAtomSet(projectFavicons.rejectedSourcesAtom);
  const source = physicalProjectKey === null ? null : selection.source;
  const projectKey = physicalProjectKey === null ? null : selection.projectKey;
  const environmentId = source?.environmentId ?? props.environmentId;
  const workspaceRoot = source?.cwd ?? props.workspaceRoot;
  const faviconPath = source ? source.faviconPath : props.faviconPath;
  const faviconState = useAssetUrlState(
    environmentId,
    workspaceRoot === null || workspaceRoot === undefined
      ? null
      : {
          _tag: "project-favicon",
          cwd: workspaceRoot,
          ...(faviconPath ? { path: faviconPath } : {}),
        },
  );
  const faviconUrl = faviconState._tag === "Success" ? faviconState.url : null;
  const faviconIsMissing =
    faviconState._tag === "Success" && isProjectFaviconFallbackUrl(faviconState.url);
  const subscribe = useCallback(
    (listener: () => void) =>
      projectKey === null ? () => {} : subscribeProjectFavicons(projectKey, listener),
    [projectKey],
  );
  const getSnapshot = useCallback(
    () => (projectKey === null ? null : getLoadedProjectFavicon(projectKey)),
    [projectKey],
  );
  const loadedFavicon = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const missingLoadedSource =
    faviconIsMissing &&
    loadedFavicon !== null &&
    workspaceRoot != null &&
    loadedFavicon.cacheKey ===
      getProjectFaviconCacheKey(environmentId, workspaceRoot, loadedFavicon.src);

  useLayoutEffect(() => {
    if (faviconIsMissing && source !== null) {
      const rejectedSourceKey = getProjectFaviconSourceRejectionKey(source);
      rejectSources((current) =>
        current.has(rejectedSourceKey) ? current : new Set(current).add(rejectedSourceKey),
      );
    }
    if (missingLoadedSource && projectKey !== null) {
      forgetProjectFavicon(projectKey);
    }
  }, [faviconIsMissing, missingLoadedSource, projectKey, rejectSources, source]);

  const cacheKey =
    faviconUrl && workspaceRoot && !faviconIsMissing
      ? getProjectFaviconCacheKey(environmentId, workspaceRoot, faviconUrl)
      : null;

  return (
    <ProjectFaviconImage
      key={projectKey}
      projectKey={projectKey}
      cacheKey={cacheKey}
      faviconUrl={faviconIsMissing ? null : faviconUrl}
      loadedFavicon={missingLoadedSource ? null : loadedFavicon}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly projectKey: string | null;
  readonly cacheKey: string | null;
  readonly faviconUrl: string | null;
  readonly loadedFavicon: { readonly cacheKey: string; readonly src: string } | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");
  const currentRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const loadedRequest = useMemo(
    () =>
      createProjectFaviconRequest(
        props.loadedFavicon?.cacheKey ?? null,
        props.loadedFavicon?.src ?? null,
      ),
    [props.loadedFavicon?.cacheKey, props.loadedFavicon?.src],
  );
  const replacementRequest =
    currentRequest &&
    (currentRequest.cacheKey !== loadedRequest?.cacheKey ||
      currentRequest.faviconUrl !== loadedRequest.faviconUrl)
      ? currentRequest
      : null;

  useLayoutEffect(() => {
    if (replacementRequest === null) return;
    return beginProjectFaviconRequest(replacementRequest);
  }, [replacementRequest]);

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {loadedRequest === null ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {[loadedRequest, replacementRequest].map((faviconRequest, index) => {
        if (faviconRequest === null) return null;

        const isReplacement = index === 1;
        return (
          <Image
            key={isReplacement ? faviconRequest.faviconUrl : props.projectKey}
            source={{
              uri: faviconRequest.faviconUrl,
              cacheKey: faviconRequest.cacheKey,
            }}
            cachePolicy="memory-disk"
            recyclingKey={isReplacement ? faviconRequest.cacheKey : (props.projectKey ?? undefined)}
            accessibilityLabel={isReplacement ? undefined : `${props.projectTitle} favicon`}
            style={{
              width: props.size,
              height: props.size,
              borderRadius: props.size * 0.16,
              ...(isReplacement ? { position: "absolute" as const, opacity: 0 } : {}),
            }}
            contentFit="contain"
            onLoad={() => {
              if (!isReplacement || !isCurrentProjectFaviconRequest(faviconRequest)) return;
              if (props.projectKey !== null) {
                rememberProjectFavicon(props.projectKey, {
                  cacheKey: faviconRequest.cacheKey,
                  src: faviconRequest.faviconUrl,
                });
              }
            }}
            onError={() => {
              if (isReplacement && !isCurrentProjectFaviconRequest(faviconRequest)) return;
              if (props.projectKey !== null) {
                forgetProjectFavicon(props.projectKey, faviconRequest.faviconUrl);
              }
            }}
          />
        );
      })}
    </View>
  );
}
