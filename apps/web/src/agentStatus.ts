import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type AgentHealthState = "healthy" | "possibly-stalled" | "stalled" | "provider-error";

export interface AgentProviderIssue {
  readonly kind: "rate-limit" | "quota" | "auth" | "connection" | "timeout" | "provider";
  readonly label: string;
  readonly retryAfter: string | null;
}

const STATUS_QUERY_PATTERNS = [
  /\bprogress(?:\s+update)?\b/i,
  /\bwhere\s+(?:are\s+we|are\s+the\s+agents|are\s+things)\b/i,
  /\bwhat\s+(?:are|is)\s+(?:the\s+)?agents?\s+doing\b/i,
  /\bhow\s+(?:are|is)\s+(?:the\s+)?agents?\s+(?:doing|progressing)\b/i,
  /\bstatus\s+(?:update|report)\b/i,
  /\bagent\s+status\b/i,
];

export function isAgentProgressStatusQuery(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return STATUS_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function allPanelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  const seen = new Set<string>();
  const out: RuntimeSubagent[] = [];
  const add = (agent: RuntimeSubagent) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    out.push(agent);
  };
  for (const group of model.workflows) {
    add(group.workflow);
    for (const phase of group.phases) for (const member of phase.members) add(member);
    for (const member of group.unphasedMembers) add(member);
  }
  for (const agent of model.directAgents) add(agent);
  return out;
}

export function latestMeaningfulAgentActivityAt(agent: RuntimeSubagent): string | null {
  return agent.recentActivity.at(-1)?.at ?? agent.startedAt ?? agent.completedAt ?? null;
}

export function classifyAgentProviderIssue(error: string | null): AgentProviderIssue | null {
  if (!error) return null;
  const value = error.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const retryMatch = value.match(/retry(?:-|\s)?after\s*[:=]?\s*([^,;\n]+)/i);
  const retryAfter = retryMatch?.[1]?.trim() ?? null;
  if (/\b429\b|rate[ -]?limit|too many requests/.test(lower)) {
    return { kind: "rate-limit", label: "Rate limited", retryAfter };
  }
  if (/quota|usage limit|credits? exhausted|insufficient credits?/.test(lower)) {
    return { kind: "quota", label: "Quota exhausted", retryAfter };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(lower)) {
    return { kind: "auth", label: "Authentication failed", retryAfter };
  }
  if (/timed? out|timeout|deadline exceeded/.test(lower)) {
    return { kind: "timeout", label: "Provider timed out", retryAfter };
  }
  if (
    /connection reset|connection refused|network error|fetch failed|socket hang up|disconnected/.test(
      lower,
    )
  ) {
    return { kind: "connection", label: "Connection failed", retryAfter };
  }
  if (/provider|opencode|model request failed|api error/.test(lower)) {
    return { kind: "provider", label: "Provider error", retryAfter };
  }
  return null;
}

export function deriveAgentHealth(
  agent: RuntimeSubagent,
  nowMs = Date.now(),
): {
  readonly state: AgentHealthState;
  readonly inactiveMs: number | null;
  readonly issue: AgentProviderIssue | null;
} {
  const issue = classifyAgentProviderIssue(agent.error);
  if (issue) return { state: "provider-error", inactiveMs: null, issue };
  if (agent.status !== "running" && agent.status !== "pending" && agent.status !== "waiting") {
    return { state: "healthy", inactiveMs: null, issue: null };
  }
  const activityAt = latestMeaningfulAgentActivityAt(agent);
  if (!activityAt) return { state: "healthy", inactiveMs: null, issue: null };
  const activityMs = Date.parse(activityAt);
  if (!Number.isFinite(activityMs)) return { state: "healthy", inactiveMs: null, issue: null };
  const inactiveMs = Math.max(0, nowMs - activityMs);
  if (inactiveMs >= 10 * 60_000) return { state: "stalled", inactiveMs, issue: null };
  if (inactiveMs >= 5 * 60_000) return { state: "possibly-stalled", inactiveMs, issue: null };
  return { state: "healthy", inactiveMs, issue: null };
}

export function formatRelativeActivity(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function formatAgentProgressSummary(model: AgentPanelModel, nowMs = Date.now()): string {
  const agents = allPanelAgents(model).filter((agent) => agent.kind !== "workflow");
  if (agents.length === 0) {
    return "No child agents have been launched for this thread yet.";
  }
  const lines = agents.map((agent) => {
    const health = deriveAgentHealth(agent, nowMs);
    const status = health.issue
      ? `⚠ ${health.issue.label}${health.issue.retryAfter ? ` · retry after ${health.issue.retryAfter}` : ""}`
      : health.state === "stalled"
        ? "⚠ Stalled"
        : health.state === "possibly-stalled"
          ? "⚠ Possibly stalled"
          : agent.status === "completed"
            ? "✓ Completed"
            : agent.status === "failed"
              ? "✕ Failed"
              : agent.status === "cancelled" || agent.status === "interrupted"
                ? "■ Stopped"
                : agent.status === "waiting"
                  ? "Waiting"
                  : agent.status === "idle"
                    ? "Idle"
                    : "Working";
    const activityAt = latestMeaningfulAgentActivityAt(agent);
    const activityMs = activityAt ? Date.parse(activityAt) : Number.NaN;
    const lastActivity = Number.isFinite(activityMs)
      ? ` · last activity ${formatRelativeActivity(Math.max(0, nowMs - activityMs))}`
      : "";
    const detail = agent.progress ?? agent.result ?? agent.error ?? agent.lastToolName;
    return `- **${agent.title}** — ${status}${lastActivity}${detail ? `\n  ${detail}` : ""}`;
  });
  const live = agents.filter(
    (agent) =>
      agent.status === "pending" || agent.status === "running" || agent.status === "waiting",
  ).length;
  const settled = agents.length - live;
  return [`**Agent progress:** ${live} active · ${settled} settled`, "", ...lines].join("\n");
}
