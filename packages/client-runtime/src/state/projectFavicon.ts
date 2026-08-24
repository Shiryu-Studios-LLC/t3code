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

export interface ProjectFaviconSelection {
  readonly projectKey: string;
  readonly source: ProjectFaviconSource | null;
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
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): boolean {
  const currentIsConnected = connectedEnvironmentIds.has(current.environmentId);
  const candidateIsConnected = connectedEnvironmentIds.has(candidate.environmentId);
  if (currentIsConnected !== candidateIsConnected) return candidateIsConnected;

  const currentHasOverride = current.faviconPath != null;
  const candidateHasOverride = candidate.faviconPath != null;
  if (currentHasOverride !== candidateHasOverride) return candidateHasOverride;

  return derivePhysicalProjectKey(candidate) < derivePhysicalProjectKey(current);
}

function scopeProjectFaviconKey(projectKey: string, accountId: string | null): string {
  return accountId ? `${accountId}:${projectKey}` : projectKey;
}

function sourceRejectionKey(
  projectKey: string,
  environmentId: EnvironmentId,
  cwd: string,
  faviconPath: string | null,
): string {
  return `${projectKey}\0${environmentId}\0${cwd}\0${faviconPath ?? ""}`;
}

export function getProjectFaviconSourceRejectionKey(source: ProjectFaviconSource): string {
  return sourceRejectionKey(
    source.projectKey,
    source.environmentId,
    source.cwd,
    source.faviconPath,
  );
}

export function selectProjectFaviconSources(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly accountId?: string | null;
  readonly rejectedSourceKeys?: ReadonlySet<string>;
}): ReadonlyMap<string, ProjectFaviconSource> {
  const sources = new Map<string, ProjectFaviconSource>();
  const groups = buildProjectGroups({ projects: input.projects, settings: input.settings });

  for (const group of groups) {
    const projectKey = scopeProjectFaviconKey(group.key, input.accountId ?? null);
    const availableMembers = group.members.filter(
      ({ project }) =>
        !input.rejectedSourceKeys?.has(
          sourceRejectionKey(
            projectKey,
            project.environmentId,
            project.workspaceRoot,
            project.faviconPath ?? null,
          ),
        ),
    );
    const candidates = availableMembers.length > 0 ? availableMembers : group.members;
    // Older duplicate records can contain an icon that the current record cleared.
    const source = candidates.reduce(
      (current, member) =>
        shouldReplaceFaviconSource(current, member.project, input.connectedEnvironmentIds)
          ? member.project
          : current,
      candidates[0]!.project,
    );
    const faviconSource: ProjectFaviconSource = {
      projectKey,
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
  readonly groupingSettingsAtom: Atom.Atom<ProjectGroupingSettings>;
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly accountSessionAtom: Atom.Atom<{ readonly accountId: string } | null>;
  readonly label: string;
}) {
  const rejectedSourcesAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
    Atom.withLabel(`${input.label}:rejected-sources`),
  );
  const sourceMapAtom = Atom.make((get) => {
    const projects = get(input.projectsAtom);
    const connectedEnvironmentIds = new Set<EnvironmentId>();
    for (const project of projects) {
      if (Option.isSome(get(input.preparedConnectionAtom(project.environmentId)))) {
        connectedEnvironmentIds.add(project.environmentId);
      }
    }

    return selectProjectFaviconSources({
      projects,
      settings: get(input.groupingSettingsAtom),
      connectedEnvironmentIds,
      accountId: get(input.accountSessionAtom)?.accountId ?? null,
      rejectedSourceKeys: get(rejectedSourcesAtom),
    });
  }).pipe(Atom.withLabel(`${input.label}:sources`));

  const sourceAtom = Atom.family((physicalProjectKey: string) => {
    let previous: ProjectFaviconSelection | null = null;
    return Atom.make((get): ProjectFaviconSelection => {
      const source = get(sourceMapAtom).get(physicalProjectKey) ?? null;
      const projectKey =
        source?.projectKey ??
        scopeProjectFaviconKey(
          physicalProjectKey,
          get(input.accountSessionAtom)?.accountId ?? null,
        );
      if (
        projectKey === previous?.projectKey &&
        source?.environmentId === previous.source?.environmentId &&
        source?.cwd === previous.source?.cwd &&
        source?.faviconPath === previous.source?.faviconPath
      ) {
        return previous;
      }
      previous = { projectKey, source };
      return previous;
    }).pipe(Atom.withLabel(`${input.label}:${physicalProjectKey}`));
  });

  return { sourceAtom, rejectedSourcesAtom };
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
