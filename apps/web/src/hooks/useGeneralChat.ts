import {
  GENERAL_CHAT_PROJECT_ID,
  GENERAL_CHAT_PROJECT_TITLE,
  GENERAL_CHAT_WORKSPACE_ROOT,
  type EnvironmentId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { resolveNewThreadRuntimeMode } from "../newThreadRuntimeMode";
import { projectEnvironment } from "../state/projects";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

export interface StartGeneralChatOptions {
  readonly replace?: boolean;
  readonly environmentId?: EnvironmentId;
}

/**
 * General chats are backed by a reserved, hidden-from-the-workspace-intent
 * project so the existing thread/event persistence model can remain stable.
 * The backing directory is intentionally isolated and callers/UI treat the
 * conversation as projectless. New general chats intentionally use the product
 * default runtime mode (Full access).
 */
export function useGeneralChatHandler() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return useCallback(
    async (options: StartGeneralChatOptions = {}) => {
      const environmentId = options.environmentId ?? primaryEnvironmentId;
      if (!environmentId) {
        throw new Error("Connect an environment before starting a general chat.");
      }

      const exists = projects.some(
        (project) =>
          project.environmentId === environmentId && project.id === GENERAL_CHAT_PROJECT_ID,
      );
      if (!exists) {
        const createResult = await createProject({
          environmentId,
          input: {
            projectId: GENERAL_CHAT_PROJECT_ID,
            title: GENERAL_CHAT_PROJECT_TITLE,
            workspaceRoot: GENERAL_CHAT_WORKSPACE_ROOT,
            createWorkspaceRootIfMissing: true,
          },
        });
        if (createResult._tag === "Failure") {
          const error = squashAtomCommandFailure(createResult);
          throw error instanceof Error ? error : new Error("Could not initialize General Chat.");
        }
      }

      return handleNewThread(scopeProjectRef(environmentId, GENERAL_CHAT_PROJECT_ID), {
        replace: options.replace ?? false,
        envMode: "local",
        branch: null,
        worktreePath: null,
        runtimeMode: resolveNewThreadRuntimeMode(),
      });
    },
    [createProject, handleNewThread, primaryEnvironmentId, projects],
  );
}
