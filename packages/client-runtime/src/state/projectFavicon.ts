import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

export interface ProjectFaviconSource {
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath: string | null;
}

export interface LoadedProjectFavicon {
  readonly cacheKey: string;
  readonly src: string;
}

const loadedFavicons = new Map<string, LoadedProjectFavicon>();
const faviconListeners = new Map<string, Set<() => void>>();
const MAX_LOADED_FAVICONS = 256;

function shouldReplaceFaviconSource(
  current: EnvironmentProject,
  candidate: EnvironmentProject,
  input: {
    readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly preferredEnvironmentId?: EnvironmentId | null;
  },
): boolean {
  const currentIsConnected = input.connectedEnvironmentIds.has(current.environmentId);
  const candidateIsConnected = input.connectedEnvironmentIds.has(candidate.environmentId);
  if (currentIsConnected !== candidateIsConnected) return candidateIsConnected;

  const currentHasOverride = current.faviconPath != null;
  const candidateHasOverride = candidate.faviconPath != null;
  if (currentHasOverride !== candidateHasOverride) return candidateHasOverride;

  const currentIsPreferred = current.environmentId === input.preferredEnvironmentId;
  const candidateIsPreferred = candidate.environmentId === input.preferredEnvironmentId;
  if (currentIsPreferred !== candidateIsPreferred) return candidateIsPreferred;

  return derivePhysicalProjectKey(candidate) < derivePhysicalProjectKey(current);
}

export function selectProjectFaviconSources(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly preferredEnvironmentId?: EnvironmentId | null;
}): ReadonlyMap<string, ProjectFaviconSource> {
  const sources = new Map<string, ProjectFaviconSource>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.preferredEnvironmentId ?? null,
  });

  for (const group of groups) {
    // Older duplicate records can contain an icon that the current record cleared.
    const source = group.members.reduce(
      (current, member) =>
        shouldReplaceFaviconSource(current, member.project, input) ? member.project : current,
      group.representative,
    );
    const faviconSource: ProjectFaviconSource = {
      projectKey: group.key,
      environmentId: source.environmentId,
      cwd: source.workspaceRoot,
      faviconPath: source.faviconPath ?? null,
    };

    for (const member of group.members) {
      sources.set(member.physicalProjectKey, faviconSource);
    }
  }

  return sources;
}

export function createProjectFaviconSourceAtoms(input: {
  readonly projectsAtom: Atom.Atom<ReadonlyArray<EnvironmentProject>>;
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly preferredEnvironmentIdAtom?: Atom.Atom<EnvironmentId | null>;
  readonly label: string;
}) {
  const sourceMapAtom = Atom.family((settingsKey: string) => {
    const settings = JSON.parse(settingsKey) as ProjectGroupingSettings;
    return Atom.make((get) => {
      const projects = get(input.projectsAtom);
      const connectedEnvironmentIds = new Set<EnvironmentId>();
      for (const project of projects) {
        if (Option.isSome(get(input.preparedConnectionAtom(project.environmentId)))) {
          connectedEnvironmentIds.add(project.environmentId);
        }
      }

      return selectProjectFaviconSources({
        projects,
        settings,
        connectedEnvironmentIds,
        preferredEnvironmentId: input.preferredEnvironmentIdAtom
          ? get(input.preferredEnvironmentIdAtom)
          : null,
      });
    }).pipe(Atom.withLabel(`${input.label}:sources`));
  });

  const projectSourceAtom = Atom.family((physicalProjectKey: string) =>
    Atom.family((settingsKey: string) => {
      let previous: ProjectFaviconSource | null = null;
      return Atom.make((get) => {
        const source = get(sourceMapAtom(settingsKey)).get(physicalProjectKey) ?? null;
        if (
          source?.projectKey === previous?.projectKey &&
          source?.environmentId === previous?.environmentId &&
          source?.cwd === previous?.cwd &&
          source?.faviconPath === previous?.faviconPath
        ) {
          return previous;
        }
        previous = source;
        return source;
      }).pipe(Atom.withLabel(`${input.label}:${physicalProjectKey}`));
    }),
  );

  return {
    sourceAtom: (physicalProjectKey: string, settings: ProjectGroupingSettings) =>
      projectSourceAtom(physicalProjectKey)(JSON.stringify(settings)),
  };
}

function notifyFaviconListeners(projectKey: string): void {
  for (const listener of faviconListeners.get(projectKey) ?? []) listener();
}

export function getLoadedProjectFavicon(projectKey: string): LoadedProjectFavicon | null {
  return loadedFavicons.get(projectKey) ?? null;
}

export function rememberProjectFavicon(projectKey: string, favicon: LoadedProjectFavicon): void {
  const existing = loadedFavicons.get(projectKey);
  if (existing?.cacheKey === favicon.cacheKey && existing.src === favicon.src) return;

  loadedFavicons.delete(projectKey);
  loadedFavicons.set(projectKey, favicon);
  if (loadedFavicons.size > MAX_LOADED_FAVICONS) {
    const oldestProjectKey = loadedFavicons.keys().next().value;
    if (oldestProjectKey !== undefined) {
      loadedFavicons.delete(oldestProjectKey);
      notifyFaviconListeners(oldestProjectKey);
    }
  }

  notifyFaviconListeners(projectKey);
}

export function forgetProjectFavicon(projectKey: string, src?: string): void {
  const existing = loadedFavicons.get(projectKey);
  if (!existing || (src !== undefined && existing.src !== src)) return;

  loadedFavicons.delete(projectKey);
  notifyFaviconListeners(projectKey);
}

export function clearProjectFavicons(): void {
  for (const projectKey of loadedFavicons.keys()) {
    forgetProjectFavicon(projectKey);
  }
}

export function subscribeProjectFavicons(projectKey: string, listener: () => void): () => void {
  let listeners = faviconListeners.get(projectKey);
  if (!listeners) {
    listeners = new Set();
    faviconListeners.set(projectKey, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) faviconListeners.delete(projectKey);
  };
}
