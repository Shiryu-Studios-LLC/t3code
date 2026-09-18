import {
  AlertTriangleIcon,
  AlertCircleIcon,
  ServerIcon,
  LockIcon,
  InfoIcon,
  ChevronRightIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useRuntimeStatus, type RuntimeStatusIssue } from "~/hooks/useRuntimeStatus";

interface RuntimeStatusIndicatorProps {
  threadRef: { environmentId: string; threadId: string } | null;
  className?: string;
}

const categoryIcon = (category: RuntimeStatusIssue["category"]) => {
  switch (category) {
    case "mcp":
      return ServerIcon;
    case "permissions":
      return LockIcon;
    default:
      return InfoIcon;
  }
};

const categoryLabel = (category: RuntimeStatusIssue["category"]) => {
  switch (category) {
    case "mcp":
      return "MCP Server";
    case "permissions":
      return "Permissions";
    default:
      return "Runtime";
  }
};

interface IssueItemProps {
  issue: RuntimeStatusIssue;
}

function IssueItem({ issue }: IssueItemProps) {
  const CategoryIcon = categoryIcon(issue.category);
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div
      className={cn(
        "flex items-start gap-2 p-2 rounded-md text-sm transition-colors",
        issue.kind === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-warning/10 text-warning",
      )}
    >
      <CategoryIcon className="size-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{categoryLabel(issue.category)}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(issue.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <p className="mt-0.5 text-xs">{issue.message}</p>
        {issue.detail && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setShowDetail(!showDetail)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn("size-3 shrink-0 transition-transform", showDetail && "rotate-90")}
              />
              {showDetail ? "Hide details" : "Show details"}
            </button>
            {showDetail && (
              <pre className="mt-1 text-[10px] overflow-x-auto rounded bg-background p-1.5">
                {JSON.stringify(issue.detail, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const RuntimeStatusIndicator = memo(function RuntimeStatusIndicator({
  threadRef,
  className,
}: RuntimeStatusIndicatorProps) {
  const issues = useRuntimeStatus(threadRef);
  const [expanded, setExpanded] = useState(false);

  if (issues.length === 0) {
    return null;
  }

  const hasErrors = issues.some((i) => i.kind === "error");
  const mcpIssues = issues.filter((i) => i.category === "mcp");
  const permissionIssues = issues.filter((i) => i.category === "permissions");
  const otherIssues = issues.filter((i) => i.category === "other");

  const Icon = hasErrors ? AlertCircleIcon : AlertTriangleIcon;
  const colorClass = hasErrors ? "text-destructive" : "text-warning";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={cn(
              "relative inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              colorClass,
              expanded ? "bg-accent" : "hover:bg-accent/50",
              className,
            )}
            aria-label="Runtime status issues"
            aria-expanded={expanded}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">
              {mcpIssues.length > 0 && permissionIssues.length > 0
                ? "MCP & Permissions"
                : mcpIssues.length > 0
                  ? "MCP Issues"
                  : permissionIssues.length > 0
                    ? "Permission Issues"
                    : "Runtime Issues"}
            </span>
            {issues.length > 1 && (
              <span
                className={cn(
                  "size-4 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold",
                  hasErrors
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-warning text-warning-foreground",
                )}
              >
                {issues.length}
              </span>
            )}
          </button>
        }
      />
      <TooltipPopup side="bottom" align="start" className="w-96 p-2">
        <div className="space-y-2">
          {mcpIssues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                MCP Servers
              </p>
              {mcpIssues.map((issue, index) => (
                <IssueItem key={index} issue={issue} />
              ))}
            </div>
          )}
          {permissionIssues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Permissions
              </p>
              {permissionIssues.map((issue, index) => (
                <IssueItem key={index} issue={issue} />
              ))}
            </div>
          )}
          {otherIssues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Other
              </p>
              {otherIssues.map((issue, index) => (
                <IssueItem key={index} issue={issue} />
              ))}
            </div>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
