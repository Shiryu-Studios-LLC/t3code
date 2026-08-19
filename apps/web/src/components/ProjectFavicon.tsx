import type { EnvironmentId } from "@t3tools/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { derivePhysicalProjectKeyFromPath } from "../logicalProject";
import { cn } from "~/lib/utils";

interface LoadedProjectFavicon {
  readonly cacheKey: string;
  readonly src: string;
}

const loadedProjectFavicons = new Map<string, LoadedProjectFavicon>();

export interface ProjectFaviconSource {
  readonly projectKey?: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}

export function ProjectFavicon(
  input: ProjectFaviconSource & {
    className?: string | undefined;
    fallbackIcon?: ComponentType<{ className?: string }>;
  },
) {
  const state = useProjectFaviconAsset(input);
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;
  const projectKey =
    input.projectKey ?? derivePhysicalProjectKeyFromPath(input.environmentId, input.cwd);
  const faviconIsMissing = state._tag === "Success" && isProjectFaviconFallbackUrl(state.url);

  if (faviconIsMissing) loadedProjectFavicons.delete(projectKey);

  const loadedFavicon = loadedProjectFavicons.get(projectKey);
  const favicon =
    state._tag === "Success" && !faviconIsMissing
      ? {
          cacheKey: getProjectFaviconCacheKey(input.environmentId, input.cwd, state.url),
          src: state.url,
        }
      : faviconIsMissing
        ? null
        : (loadedFavicon ?? null);

  if (favicon === null) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  return (
    <ProjectFaviconImage
      key={projectKey}
      projectKey={projectKey}
      cacheKey={favicon.cacheKey}
      src={favicon.src}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

export function useProjectFaviconAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}) {
  return useAssetUrlState(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
    ...(input.faviconPath ? { path: input.faviconPath } : {}),
  });
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  projectKey,
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly projectKey: string;
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedProjectFavicons.get(projectKey)?.src ?? null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedProjectFavicons.get(projectKey)?.src === failedSrc) {
      loadedProjectFavicons.delete(projectKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            loadedProjectFavicons.set(projectKey, { cacheKey, src });
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
