import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  forgetProjectFavicon,
  getLoadedProjectFavicon,
  getProjectFaviconGeneration,
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
import { useMobileProjectGroupingSettings } from "../state/project-grouping";
import { projectFavicons } from "../state/projects";
import { usePreparedConnection } from "../state/session";
import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
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
  const groupingSettings = useMobileProjectGroupingSettings();
  const source = useAtomValue(
    projectFavicons.sourceAtom(physicalProjectKey ?? "", groupingSettings),
  );
  const projectKey = source?.projectKey ?? physicalProjectKey;
  const environmentId = source?.environmentId ?? props.environmentId;
  const workspaceRoot = source?.cwd ?? props.workspaceRoot;
  const faviconPath = source ? source.faviconPath : props.faviconPath;
  const preparedConnection = usePreparedConnection(environmentId);
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const relayAccountUnavailable =
    preparedConnection._tag === "Some" &&
    preparedConnection.value.target._tag === "RelayConnectionTarget" &&
    relaySession === null;
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
  const faviconUrl =
    faviconState._tag === "Success" && !relayAccountUnavailable ? faviconState.url : null;
  const faviconIsMissing =
    faviconState._tag === "Success" &&
    !relayAccountUnavailable &&
    isProjectFaviconFallbackUrl(faviconState.url);
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

  useEffect(() => {
    if (faviconIsMissing && projectKey !== null) {
      forgetProjectFavicon(projectKey);
    }
  }, [faviconIsMissing, projectKey]);

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
      loadedFavicon={faviconIsMissing ? null : loadedFavicon}
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
  const generation = getProjectFaviconGeneration();
  const currentRequest = useMemo(() => {
    const request = createProjectFaviconRequest(props.cacheKey, props.faviconUrl);
    return request === null ? null : { ...request, generation };
  }, [generation, props.cacheKey, props.faviconUrl]);
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
              if (
                !isReplacement ||
                currentRequest?.generation !== getProjectFaviconGeneration() ||
                !markProjectFaviconLoaded(faviconRequest)
              ) {
                return;
              }
              if (props.projectKey !== null) {
                rememberProjectFavicon(
                  props.projectKey,
                  { cacheKey: faviconRequest.cacheKey, src: faviconRequest.faviconUrl },
                  currentRequest.generation,
                );
              }
            }}
            onError={() => {
              if (isReplacement && !markProjectFaviconFailed(faviconRequest)) return;
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
