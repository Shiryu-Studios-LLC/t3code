import { isGeneralChatProjectId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { FolderPlusIcon, LinkIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useProjects } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function GeneralChatAttachProject({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projects = useProjects();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [attachingProjectId, setAttachingProjectId] = useState<string | null>(null);
  const candidates = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId && !isGeneralChatProjectId(project.id),
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, projects],
  );

  const attach = async (projectId: (typeof candidates)[number]["id"]) => {
    if (attachingProjectId !== null) return;
    setAttachingProjectId(projectId);
    try {
      await updateThreadMetadata({
        environmentId,
        input: {
          threadId,
          projectId,
          branch: null,
          worktreePath: null,
        },
      });
    } finally {
      setAttachingProjectId(null);
    }
  };

  return (
    <div className="mx-auto mt-1 flex w-fit items-center gap-2 rounded-full border border-border/60 bg-muted/25 px-2.5 py-1 text-xs text-muted-foreground">
      <span>General chat</span>
      <span aria-hidden="true">·</span>
      {candidates.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-6 gap-1.5 rounded-full px-2 text-xs"
                disabled={attachingProjectId !== null}
              />
            }
          >
            {attachingProjectId !== null ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <LinkIcon className="size-3" />
            )}
            Attach project
          </MenuTrigger>
          <MenuPopup align="center" className="max-h-72 min-w-52 overflow-y-auto">
            {candidates.map((project) => (
              <MenuItem
                key={`${project.environmentId}:${project.id}`}
                onClick={() => void attach(project.id)}
              >
                {project.title}
              </MenuItem>
            ))}
            <MenuItem onClick={() => openCommandPalette({ open: "add-project" })}>
              <FolderPlusIcon />
              New project
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 gap-1.5 rounded-full px-2 text-xs"
          onClick={() => openCommandPalette({ open: "add-project" })}
        >
          <FolderPlusIcon className="size-3" />
          Add project
        </Button>
      )}
    </div>
  );
}
