import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { createProjectFaviconSourceAtoms } from "@t3tools/client-runtime/state/project-favicon";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { mobilePreferencesAtom } from "./preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";
import { environmentSession } from "./session";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const projectGroupingSettingsAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? resolveMobileProjectGroupingSettings(preferences.value)
    : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS;
}).pipe(Atom.withLabel("mobile-project-grouping-settings"));

export const projectFavicons = createProjectFaviconSourceAtoms({
  projectsAtom: environmentProjects.projectsAtom,
  groupingSettingsAtom: projectGroupingSettingsAtom,
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  accountSessionAtom: managedRelaySessionAtom,
  label: "mobile-project-favicon",
});
