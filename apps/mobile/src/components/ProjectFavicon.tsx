import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrl } from "../state/assets";
import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  forgetLastLoadedProjectFavicon,
  getLastLoadedProjectFavicon,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
  rememberLastLoadedProjectFavicon,
} from "./projectFaviconCache";

/* ─── Component ──────────────────────────────────────────────────────── */
export interface ProjectFaviconSource {
  readonly projectKey?: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
}

export function ProjectFavicon(
  props: ProjectFaviconSource & {
    readonly open?: boolean;
    readonly size?: number;
    readonly projectTitle: string;
  },
) {
  const size = props.size ?? 42;
  const faviconUrl = useAssetUrl(
    props.environmentId,
    props.workspaceRoot === null || props.workspaceRoot === undefined
      ? null
      : {
          _tag: "project-favicon",
          cwd: props.workspaceRoot,
          ...(props.faviconPath ? { path: props.faviconPath } : {}),
        },
  );
  const projectKey = props.workspaceRoot
    ? (props.projectKey ??
      derivePhysicalProjectKeyFromPath(props.environmentId, props.workspaceRoot))
    : null;
  const faviconIsMissing = isProjectFaviconFallbackUrl(faviconUrl);
  if (faviconIsMissing && projectKey !== null) {
    forgetLastLoadedProjectFavicon(projectKey);
  }
  const currentRequest =
    faviconUrl && props.workspaceRoot && !faviconIsMissing
      ? createProjectFaviconRequest(
          getProjectFaviconCacheKey(props.environmentId, props.workspaceRoot, faviconUrl),
          faviconUrl,
        )
      : null;
  const faviconRequest = faviconIsMissing
    ? null
    : (currentRequest ?? getLastLoadedProjectFavicon(projectKey));

  return (
    <ProjectFaviconImage
      key={faviconRequest?.cacheKey ?? null}
      projectKey={projectKey}
      cacheKey={faviconRequest?.cacheKey ?? null}
      faviconUrl={faviconRequest?.faviconUrl ?? null}
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
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    hasLoadedProjectFavicon(props.cacheKey) ? "loaded" : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const showImage = requestIsActive && status === "loaded";

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
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={{
            uri: faviconRequest.faviconUrl,
            cacheKey: faviconRequest.cacheKey,
          }}
          cachePolicy="memory-disk"
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            if (props.projectKey !== null) {
              rememberLastLoadedProjectFavicon(props.projectKey, faviconRequest);
            }
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            if (props.projectKey !== null) {
              forgetLastLoadedProjectFavicon(props.projectKey, faviconRequest);
            }
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}
