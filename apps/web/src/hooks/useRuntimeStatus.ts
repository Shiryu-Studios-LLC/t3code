import { useMemo } from "react";
import { useThreadActivities } from "~/state/entities";
import { deriveRuntimeStatusIssues, type RuntimeStatusIssue } from "~/runtimeIssues";

export type { RuntimeStatusIssue } from "~/runtimeIssues";

export function useRuntimeStatus(
  ref: { environmentId: string; threadId: string } | null,
): ReadonlyArray<RuntimeStatusIssue> {
  const activities = useThreadActivities(ref as any);

  return useMemo(() => {
    return deriveRuntimeStatusIssues(activities);
  }, [activities]);
}

export function hasMcpIssues(issues: ReadonlyArray<RuntimeStatusIssue>): boolean {
  return issues.some((issue) => issue.category === "mcp");
}

export function hasPermissionIssues(issues: ReadonlyArray<RuntimeStatusIssue>): boolean {
  return issues.some((issue) => issue.category === "permissions");
}
