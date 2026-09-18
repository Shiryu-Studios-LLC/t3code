import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type RuntimeIssueCategory = "mcp" | "permissions" | "other";

export interface RuntimeStatusIssue {
  readonly kind: "warning" | "error";
  readonly message: string;
  readonly detail?: Record<string, unknown>;
  readonly timestamp: string;
  readonly category: RuntimeIssueCategory;
}

const TRANSIENT_RUNTIME_ISSUE_MAX_AGE_MS = 15 * 60 * 1000;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapJsonMessage(value: string): string {
  let current = value.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current.startsWith("{")) break;
    try {
      const parsed = recordOf(JSON.parse(current));
      if (typeof parsed?.message !== "string") break;
      current = parsed.message.trim();
    } catch {
      break;
    }
  }
  return current;
}

export function normalizeRuntimeIssueMessage(value: string): string {
  const message = unwrapJsonMessage(value);
  if (
    /nvidia/iu.test(message) &&
    (/(?:http\s*)?50[234]/iu.test(message) || /temporarily overloaded/iu.test(message))
  ) {
    return "NVIDIA is temporarily overloaded. T3 Studio retried once; try again shortly or switch models.";
  }
  return message || "Unknown runtime issue";
}

function categorizeIssue(activity: OrchestrationThreadActivity): RuntimeIssueCategory {
  const payload = recordOf(activity.payload);
  const detail = recordOf(payload?.detail);
  if (typeof payload?.serverName === "string" || typeof detail?.serverName === "string")
    return "mcp";
  if (typeof payload?.runtimeMode === "string" || typeof detail?.runtimeMode === "string")
    return "permissions";
  return "other";
}

function activityMessage(activity: OrchestrationThreadActivity): string {
  const payload = recordOf(activity.payload);
  const value = typeof payload?.message === "string" ? payload.message : activity.summary;
  return normalizeRuntimeIssueMessage(value ?? "Unknown runtime issue");
}

export function deriveRuntimeStatusIssues(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  nowMs = Date.now(),
): RuntimeStatusIssue[] {
  const issues = activities
    .filter((activity) => activity.kind === "runtime.warning" || activity.kind === "runtime.error")
    .map((activity): RuntimeStatusIssue => {
      const payload = recordOf(activity.payload);
      const detail = recordOf(payload?.detail);
      return {
        kind: activity.kind === "runtime.error" ? "error" : "warning",
        message: activityMessage(activity),
        ...(detail ? { detail } : {}),
        timestamp: activity.createdAt,
        category: categorizeIssue(activity),
      };
    })
    .filter((issue) => {
      if (issue.category !== "other") return true;
      const createdAt = Date.parse(issue.timestamp);
      return Number.isNaN(createdAt) || nowMs - createdAt <= TRANSIENT_RUNTIME_ISSUE_MAX_AGE_MS;
    })
    .toSorted((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.kind}:${issue.message.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
