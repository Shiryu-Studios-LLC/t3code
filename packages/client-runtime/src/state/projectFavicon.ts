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
  readonly hasFallback: boolean;
}

export interface ProjectFaviconSelection {
  readonly projectKey: string;
  readonly source: ProjectFaviconSource | null;
}

export interface LoadedProjectFavicon {
  readonly cacheKey: string;
  readonly src: string;
}

interface ProjectFaviconGroup {
  readonly projectKey: string;
  readonly candidates: ReadonlyArray<EnvironmentProject>;
}

const loadedFavicons = new Map<string, LoadedProjectFavicon>();
const faviconListeners = new Map<string, Set<() => void>>();
const MAX_LOADED_FAVICONS = 256;

function shouldReplaceFaviconSource(
  current: EnvironmentProject,
  candidate: EnvironmentProject,
): boolean {
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

type ProjectFaviconSourceInput = {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly accountId?: string | null;
};

function buildProjectFaviconGroups(
  input: ProjectFaviconSourceInput,
): ReadonlyMap<string, ProjectFaviconGroup> {
  const groupsByPhysicalProject = new Map<string, ProjectFaviconGroup>();
  for (const group of buildProjectGroups({ projects: input.projects, settings: input.settings })) {
    const connectedMembers = group.members.filter(({ project }) =>
      input.connectedEnvironmentIds.has(project.environmentId),
    );
    const candidates = connectedMembers.length > 0 ? connectedMembers : group.members;
    const faviconGroup: ProjectFaviconGroup = {
      projectKey: scopeProjectFaviconKey(group.key, input.accountId ?? null),
      candidates: candidates.map(({ project }) => project),
    };
    for (const member of group.members) {
      groupsByPhysicalProject.set(member.physicalProjectKey, faviconGroup);
    }
  }
  return groupsByPhysicalProject;
}

function selectProjectFaviconSource(
  group: ProjectFaviconGroup,
  rejectedSourceKeys?: ReadonlySet<string>,
): ProjectFaviconSource {
  const available = group.candidates.filter(
    (project) =>
      !rejectedSourceKeys?.has(
        sourceRejectionKey(
          group.projectKey,
          project.environmentId,
          project.workspaceRoot,
          project.faviconPath ?? null,
        ),
      ),
  );
  const candidates = available.length > 0 ? available : group.candidates;
  // Group candidates are authoritative physical winners, not stale duplicate records.
  const source = candidates.reduce((current, candidate) =>
    shouldReplaceFaviconSource(current, candidate) ? candidate : current,
  );
  return {
    projectKey: group.projectKey,
    environmentId: source.environmentId,
    cwd: source.workspaceRoot,
    faviconPath: source.faviconPath ?? null,
    hasFallback: available.length > 1,
  };
}

export function selectProjectFaviconSources(
  input: ProjectFaviconSourceInput & { readonly rejectedSourceKeys?: ReadonlySet<string> },
): ReadonlyMap<string, ProjectFaviconSource> {
  const sources = new Map<string, ProjectFaviconSource>();
  const sourceByGroup = new Map<string, ProjectFaviconSource>();
  for (const [physicalProjectKey, group] of buildProjectFaviconGroups(input)) {
    let source = sourceByGroup.get(group.projectKey);
    if (!source) {
      source = selectProjectFaviconSource(group, input.rejectedSourceKeys);
      sourceByGroup.set(group.projectKey, source);
    }
    sources.set(physicalProjectKey, source);
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
  const rejectedSourcesAtom = Atom.family((projectKey: string) =>
    Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
      Atom.withLabel(`${input.label}:rejected-sources:${projectKey}`),
    ),
  );
  const groupMapAtom = Atom.make((get) => {
    const projects = get(input.projectsAtom);
    const connectedEnvironmentIds = new Set<EnvironmentId>();
    for (const project of projects) {
      if (Option.isSome(get(input.preparedConnectionAtom(project.environmentId)))) {
        connectedEnvironmentIds.add(project.environmentId);
      }
    }

    return buildProjectFaviconGroups({
      projects,
      settings: get(input.groupingSettingsAtom),
      connectedEnvironmentIds,
      accountId: get(input.accountSessionAtom)?.accountId ?? null,
    });
  }).pipe(Atom.withLabel(`${input.label}:groups`));

  const sourceAtom = Atom.family((physicalProjectKey: string) => {
    let previous: ProjectFaviconSelection | null = null;
    return Atom.make((get): ProjectFaviconSelection => {
      const group = get(groupMapAtom).get(physicalProjectKey) ?? null;
      const source = group
        ? selectProjectFaviconSource(group, get(rejectedSourcesAtom(group.projectKey)))
        : null;
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
        source?.faviconPath === previous.source?.faviconPath &&
        source?.hasFallback === previous.source?.hasFallback
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
