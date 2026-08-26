/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  Bot,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  LayoutGrid,
  List,
  MessageSquare,
  Plus,
  Send,
  Square,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { swarmEnvironment } from "~/state/swarm";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import {
  deriveAgentHealth,
  formatRelativeActivity,
  latestMeaningfulAgentActivityAt,
} from "~/agentStatus";
import {
  collectDismissibleAgentIds,
  collectAutoArchiveAgentIds,
  filterArchivedAgents,
} from "~/agentRosterArchive";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/** Flat, non-interactive agent status line. No unfold. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const visuals = STATUS_VISUALS[agent.status];
  const active =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  const [healthNow, setHealthNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setHealthNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  const health = deriveAgentHealth(agent, healthNow);
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);
  const meaningfulActivityAt = latestMeaningfulAgentActivityAt(agent);
  const meaningfulActivityMs = meaningfulActivityAt ? Date.parse(meaningfulActivityAt) : Number.NaN;
  const lastActivity = Number.isFinite(meaningfulActivityMs)
    ? `Last activity ${formatRelativeActivity(Math.max(0, healthNow - meaningfulActivityMs))}`
    : null;
  const healthLabel = health.issue
    ? `⚠ ${health.issue.label}${health.issue.retryAfter ? ` · retry after ${health.issue.retryAfter}` : ""}`
    : health.state === "stalled"
      ? "⚠ Stalled"
      : health.state === "possibly-stalled"
        ? "⚠ Possibly stalled"
        : null;

  return (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {healthLabel ?? activity ?? visuals.label}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {[lastActivity, ...metadata].filter(Boolean).join(" · ")}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

export function swarmIntegrationState(group: AgentPanelWorkflowGroup): {
  label: string;
  detail: string;
  tone: "working" | "ready" | "failed" | "complete";
} {
  const members = workflowMembers(group);
  const live = members.filter(
    (member) =>
      member.status === "running" || member.status === "pending" || member.status === "waiting",
  );
  if (live.length > 0) {
    const currentPhase = group.phases.find((phase) => phase.state === "running");
    return {
      label: currentPhase ? `Executing · ${currentPhase.title}` : "Executing worker graph",
      detail: `${live.length} worker${live.length === 1 ? "" : "s"} active; downstream work waits for its dependencies.`,
      tone: "working",
    };
  }
  if (members.some((member) => member.status === "failed")) {
    return {
      label: "Integration needs attention",
      detail: "The orchestrator is reconciling partial results and failed worker output.",
      tone: "failed",
    };
  }
  if (group.workflow.status === "completed") {
    return {
      label: "Recombined and verified",
      detail: "Worker results were integrated into the orchestrator's final result.",
      tone: "complete",
    };
  }
  return {
    label: "Collecting worker results",
    detail:
      "All workers are settled; the orchestrator is gathering their outputs before recombination and verification.",
    tone: "working",
  };
}

function OrchestratorCard({ group }: { group: AgentPanelWorkflowGroup }) {
  const integration = swarmIntegrationState(group);
  return (
    <section className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/[.08] to-card/70 p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
          <Braces aria-hidden className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">Orchestrator · {group.workflow.title}</p>
            <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 font-mono text-[.65rem] text-muted-foreground">
              {STATUS_VISUALS[group.workflow.status].label}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-foreground/90">{integration.label}</p>
          <p className="mt-0.5 text-[.7rem] text-muted-foreground">{integration.detail}</p>
        </div>
      </div>
      <div className="mt-2 border-t border-border/50 pt-1">
        <PhaseRail group={group} />
      </div>
    </section>
  );
}

type SwarmMode = "auto" | "hybrid" | "manual";
type SwarmView = "overview" | "grid" | "history";

function flattenAgents(model: AgentPanelModel): RuntimeSubagent[] {
  return [
    ...model.workflows.flatMap((group) => [group.workflow, ...workflowMembers(group)]),
    ...model.directAgents,
  ];
}

export function buildSwarmCommand(
  kind: "launch" | "message" | "stop" | "ask-all" | "summarize" | "stop-all",
  input: {
    task?: string;
    title?: string;
    workspace?: "shared" | "worktree";
    target?: RuntimeSubagent;
    message?: string;
  },
): string {
  switch (kind) {
    case "launch":
      return [
        "[T3 Swarm Control] Launch exactly one new background child agent for this task.",
        input.title?.trim() ? `Agent title: ${input.title.trim()}` : null,
        `Workspace strategy: ${input.workspace === "shared" ? "shared checkout" : "isolated git worktree"}.`,
        "Keep it independent from the other live workers. Return immediately after launch so I can add more agents.",
        `Task: ${input.task?.trim() ?? ""}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "message":
      return `[T3 Swarm Control] Send this instruction to the live child agent \"${input.target?.title ?? "unknown"}\" (${input.target?.id ?? "unknown"}) without stopping its work:\n${input.message?.trim() ?? ""}`;
    case "stop":
      return `[T3 Swarm Control] Stop only the child agent \"${input.target?.title ?? "unknown"}\" (${input.target?.id ?? "unknown"}). Preserve its partial result and summarize what it completed.`;
    case "ask-all":
      return `[T3 Swarm Control] Broadcast this instruction to every currently live child agent. Do not cancel their existing work; treat it as an additional instruction:\n${input.message?.trim() ?? ""}`;
    case "summarize":
      return "[T3 Swarm Control] Give me an interim swarm summary now: one compact line per live or recently completed agent with current task, progress/result, blockers, and next step. Do not cancel or pause any workers.";
    case "stop-all":
      return "[T3 Swarm Control] Stop all currently live child agents. Preserve each partial result, then provide one consolidated summary of what each worker completed before stopping.";
  }
}

export function canLaunchSwarmAgent(
  mode: SwarmMode,
  activeCount: number,
  agentLimit: number,
  commandAvailable: boolean,
): boolean {
  return mode !== "auto" && commandAvailable && activeCount < agentLimit;
}

function SwarmCard({
  agent,
  onMessage,
  onStop,
}: {
  agent: RuntimeSubagent;
  onMessage?: (agent: RuntimeSubagent, message: string) => Promise<boolean>;
  onStop?: (agent: RuntimeSubagent) => Promise<boolean>;
}) {
  const active =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  const [messageOpen, setMessageOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort) ?? "default model";
  const activity = agentActivityText(agent) ?? STATUS_VISUALS[agent.status].label;
  const sendMessage = async () => {
    if (!onMessage || !message.trim()) return;
    if (await onMessage(agent, message)) {
      setMessage("");
      setMessageOpen(false);
    }
  };

  return (
    <article className="flex min-h-44 flex-col rounded-lg border border-border/70 bg-card/60 p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <StatusDot status={agent.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{agent.title}</p>
          <p className="truncate text-[.7rem] text-muted-foreground">{modelLabel}</p>
        </div>
        <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[.65rem] text-muted-foreground">
          {STATUS_VISUALS[agent.status].label}
        </span>
      </div>
      <p className="mt-3 line-clamp-3 min-h-12 text-xs leading-relaxed text-foreground/90">
        {activity}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[.65rem] text-muted-foreground">
        {agent.startedAt ? (
          <span>{elapsedBetween(agent.startedAt, active ? null : agent.completedAt)}</span>
        ) : null}
        <span>
          {agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok"}
        </span>
        {agent.usage?.toolUses !== undefined ? <span>{agent.usage.toolUses} tools</span> : null}
        {agent.runHandles?.workspacePath ? (
          <span className="truncate">{agent.runHandles.workspacePath}</span>
        ) : null}
        {!agent.runHandles?.workspacePath && agent.runHandles?.scriptPath ? (
          <span className="truncate">{agent.runHandles.scriptPath}</span>
        ) : null}
      </div>
      {messageOpen ? (
        <div className="mt-3 flex gap-1.5">
          <input
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendMessage();
              if (event.key === "Escape") setMessageOpen(false);
            }}
            placeholder="Instruction for this agent…"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
          />
          <Button size="icon-micro" onClick={sendMessage} disabled={!message.trim()}>
            <Send aria-hidden className="size-3" />
          </Button>
        </div>
      ) : null}
      {detailsOpen ? (
        <div className="mt-3 rounded-md border border-border/60 bg-background/60 p-2">
          <p className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
            Recent activity
          </p>
          <div className="mt-1.5 space-y-1">
            {agent.recentActivity.length > 0 ? (
              agent.recentActivity.slice(-6).map((entry) => (
                <div
                  key={`${entry.at}:${entry.summary}`}
                  className="text-[.7rem] leading-relaxed text-foreground/85"
                >
                  <span className="mr-1 font-mono text-muted-foreground">
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {entry.summary}
                </div>
              ))
            ) : (
              <p className="text-[.7rem] text-muted-foreground">
                No detailed activity has been reported yet.
              </p>
            )}
          </div>
          {agent.result ? (
            <p className="mt-2 text-[.7rem] leading-relaxed">
              <span className="font-medium">Result:</span> {agent.result}
            </p>
          ) : null}
          {agent.error ? (
            <p className="mt-2 text-[.7rem] leading-relaxed text-destructive-foreground">
              <span className="font-medium">Error:</span> {agent.error}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-auto flex gap-1.5 pt-3">
        <Button size="xs" variant="ghost-muted" onClick={() => setDetailsOpen((value) => !value)}>
          {detailsOpen ? "Hide details" : "Details"}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!active || !onMessage}
          onClick={() => setMessageOpen((value) => !value)}
        >
          <MessageSquare aria-hidden className="mr-1 size-3" /> Message
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!active || !onStop}
          onClick={() => void onStop?.(agent)}
        >
          <Square aria-hidden className="mr-1 size-3" /> Stop
        </Button>
      </div>
    </article>
  );
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? phase.members.map((member) => <AgentRow key={member.id} agent={member} />) : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection key={phase.index} phase={phase} defaultOpen={!workflowIsLive(group)} />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  parentTurnCompleted = false,
  orchestratorBusy = false,
  agentLimit,
  projectCwd,
  onCommand,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  parentTurnCompleted?: boolean;
  orchestratorBusy?: boolean;
  agentLimit?: number;
  projectCwd?: string;
  onCommand?: (command: string) => boolean;
}) {
  const configuredAgentLimit = usePrimarySettings((settings) => settings.agentTeamMaxConcurrency);
  const serverAgentTeamMode = usePrimarySettings((settings) => settings.agentTeamMode);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const effectiveAgentLimit = Math.min(15, agentLimit ?? configuredAgentLimit);
  const launchAgentMutation = useAtomCommand(swarmEnvironment.launchAgent, {
    reportFailure: false,
  });
  const messageAgentMutation = useAtomCommand(swarmEnvironment.messageAgent, {
    reportFailure: false,
  });
  const stopAgentMutation = useAtomCommand(swarmEnvironment.stopAgent, { reportFailure: false });
  const archiveStorageKey =
    environmentId && threadId ? `t3:agents:archived:${environmentId}:${threadId}` : null;
  const swarmModeStorageKey =
    environmentId && threadId ? `t3:swarm:mode:${environmentId}:${threadId}` : null;
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => {
    if (!archiveStorageKey || typeof window === "undefined") return new Set();
    try {
      const parsed = JSON.parse(window.localStorage.getItem(archiveStorageKey) ?? "[]");
      return new Set(
        Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [],
      );
    } catch {
      return new Set();
    }
  });
  const [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<SwarmView>("grid");
  const [mode, setMode] = useState<SwarmMode>(() => {
    if (!swarmModeStorageKey || typeof window === "undefined") return "auto";
    const stored = window.localStorage.getItem(swarmModeStorageKey);
    return stored === "hybrid" || stored === "manual" ? stored : "auto";
  });
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchTitle, setLaunchTitle] = useState("");
  const [launchTask, setLaunchTask] = useState("");
  const [workspaceStrategy, setWorkspaceStrategy] = useState<"shared" | "worktree">("worktree");
  const [broadcast, setBroadcast] = useState("");
  const [commandNotice, setCommandNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmModeStorageKey || typeof window === "undefined") return;
    const stored = window.localStorage.getItem(swarmModeStorageKey);
    setMode(stored === "hybrid" || stored === "manual" ? stored : "auto");
  }, [swarmModeStorageKey]);

  const updateMode = (next: SwarmMode) => {
    setMode(next);
    if (serverAgentTeamMode === "off") {
      updatePrimarySettings({ agentTeamMode: "auto" });
    }
    if (swarmModeStorageKey && typeof window !== "undefined") {
      window.localStorage.setItem(swarmModeStorageKey, next);
    }
  };

  const dispatchCommand = (command: string): boolean => {
    const accepted = onCommand?.(command) ?? false;
    setCommandNotice(
      accepted
        ? "Sent to the swarm lead."
        : "Could not send while the composer is busy or contains an unsent draft.",
    );
    return accepted;
  };

  useEffect(() => {
    setShowArchived(false);
    if (!archiveStorageKey || typeof window === "undefined") {
      setArchivedIds(new Set());
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(archiveStorageKey) ?? "[]");
      setArchivedIds(
        new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []),
      );
    } catch {
      setArchivedIds(new Set());
    }
  }, [archiveStorageKey]);

  useEffect(() => {
    if (!archiveStorageKey) return;
    const autoArchive = collectAutoArchiveAgentIds(model, parentTurnCompleted);
    if (autoArchive.size === 0) return;
    setArchivedIds((current) => {
      const next = new Set(current);
      for (const id of autoArchive) next.add(id);
      window.localStorage.setItem(archiveStorageKey, JSON.stringify([...next]));
      return next;
    });
  }, [archiveStorageKey, model, parentTurnCompleted]);

  const visibleModel = showArchived ? model : filterArchivedAgents(model, archivedIds);
  const dismissibleIds = collectDismissibleAgentIds(model, Date.now());
  const clearCompleted = () => {
    if (!archiveStorageKey) return;
    setArchivedIds((current) => {
      const next = new Set(current);
      for (const id of dismissibleIds) next.add(id);
      window.localStorage.setItem(archiveStorageKey, JSON.stringify([...next]));
      return next;
    });
    setShowArchived(false);
  };
  const activeAgents = flattenAgents(filterArchivedAgents(model, archivedIds)).filter(
    (agent) => agent.kind !== "workflow",
  );
  const historyAgents = flattenAgents(model).filter(
    (agent) => agent.kind !== "workflow" && archivedIds.has(agent.id),
  );
  const activeCount = activeAgents.filter(
    (agent) =>
      agent.status === "running" || agent.status === "pending" || agent.status === "waiting",
  ).length;
  const canLaunch = canLaunchSwarmAgent(mode, activeCount, effectiveAgentLimit, Boolean(onCommand));
  const launchAgent = async () => {
    if (!launchTask.trim() || !canLaunch || !environmentId || !threadId) return;
    setCommandNotice("Launching agent…");
    const result = await launchAgentMutation({
      environmentId,
      input: {
        threadId,
        task: launchTask.trim(),
        ...(launchTitle.trim() ? { title: launchTitle.trim() } : {}),
        workspaceStrategy,
        ...(projectCwd ? { projectCwd } : {}),
      },
    });
    if (result._tag === "Success") {
      setCommandNotice(
        `Launched ${result.value.title}${result.value.workspacePath ? ` in ${result.value.workspacePath}` : ""}.`,
      );
      setLaunchTitle("");
      setLaunchTask("");
      setLaunchOpen(false);
    } else {
      setCommandNotice(
        "The backend could not launch this agent. Check provider readiness and try again.",
      );
    }
  };
  const messageAgent = async (agent: RuntimeSubagent, message: string): Promise<boolean> => {
    if (!environmentId || !threadId) return false;
    const result = await messageAgentMutation({
      environmentId,
      input: { threadId, agentId: agent.id, message: message.trim() },
    });
    setCommandNotice(
      result._tag === "Success"
        ? `Message sent to ${agent.title}.`
        : `Could not message ${agent.title}.`,
    );
    return result._tag === "Success";
  };
  const stopAgent = async (agent: RuntimeSubagent): Promise<boolean> => {
    if (!environmentId || !threadId) return false;
    const result = await stopAgentMutation({
      environmentId,
      input: { threadId, agentId: agent.id },
    });
    setCommandNotice(
      result._tag === "Success"
        ? `Stop requested for ${agent.title}.`
        : `Could not stop ${agent.title}.`,
    );
    return result._tag === "Success";
  };
  const askAll = () => {
    if (!broadcast.trim()) return;
    if (dispatchCommand(buildSwarmCommand("ask-all", { message: broadcast }))) {
      setBroadcast("");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Users aria-hidden className="size-4" /> Swarm
            </p>
            <p className="text-xs text-muted-foreground">
              {activeCount}/{effectiveAgentLimit} active ·{" "}
              {formatSubagentTokenCount(visibleModel.totalTokens)} tokens
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {(["auto", "hybrid", "manual"] as const).map((candidate) => (
              <Button
                key={candidate}
                size="xs"
                variant={mode === candidate ? "secondary" : "ghost-muted"}
                onClick={() => updateMode(candidate)}
              >
                {candidate === "auto" ? "Auto" : candidate === "hybrid" ? "Hybrid" : "Manual"}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="ghost-muted" onClick={() => setView("overview")}>
            <List aria-hidden className="mr-1 size-3" /> Overview
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => setView("grid")}>
            <LayoutGrid aria-hidden className="mr-1 size-3" /> Grid
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => setView("history")}>
            <History aria-hidden className="mr-1 size-3" /> Previous swarms
          </Button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button
              size="xs"
              variant="secondary"
              disabled={!canLaunch}
              title={
                mode === "auto" ? "Switch to Hybrid or Manual to add agents yourself." : undefined
              }
              onClick={() => setLaunchOpen((value) => !value)}
            >
              <Plus aria-hidden className="mr-1 size-3" /> Add agent
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!onCommand}
              onClick={() => dispatchCommand(buildSwarmCommand("summarize", {}))}
            >
              <WandSparkles aria-hidden className="mr-1 size-3" /> Summarize now
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={activeCount === 0 || !onCommand}
              onClick={() => dispatchCommand(buildSwarmCommand("stop-all", {}))}
            >
              <Square aria-hidden className="mr-1 size-3" /> Stop swarm
            </Button>
          </div>
        </div>
        {launchOpen ? (
          <div className="mt-2 rounded-md border border-border/70 bg-background/60 p-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={launchTitle}
                onChange={(event) => setLaunchTitle(event.currentTarget.value)}
                placeholder="Agent title (optional)"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
              />
              <select
                value={workspaceStrategy}
                onChange={(event) =>
                  setWorkspaceStrategy(event.currentTarget.value as "shared" | "worktree")
                }
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
              >
                <option value="worktree">Isolated Git worktree</option>
                <option value="shared">Shared checkout</option>
              </select>
            </div>
            <textarea
              value={launchTask}
              onChange={(event) => setLaunchTask(event.currentTarget.value)}
              placeholder="What should this agent do?"
              rows={3}
              className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <Button size="xs" variant="ghost-muted" onClick={() => setLaunchOpen(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={!launchTask.trim() || !canLaunch}
                onClick={() => void launchAgent()}
              >
                Launch agent
              </Button>
            </div>
          </div>
        ) : null}
        {commandNotice ? (
          <p className="mt-1.5 text-[.7rem] text-muted-foreground">{commandNotice}</p>
        ) : null}
      </div>
      <div className="shrink-0 space-y-2 border-b border-border/60 bg-background/80 p-3 backdrop-blur">
        {visibleModel.workflows.length > 0 ? (
          visibleModel.workflows.map((group) => (
            <OrchestratorCard key={group.workflow.id} group={group} />
          ))
        ) : (
          <section className="rounded-xl border border-primary/20 bg-primary/[.04] p-3">
            <div className="flex items-center gap-2">
              <Braces aria-hidden className="size-4 text-primary" />
              <p className="text-sm font-semibold">Orchestrator · Thread lead</p>
              <span className="ml-auto rounded-full border border-border/70 px-2 py-0.5 font-mono text-[.65rem] text-muted-foreground">
                {activeCount > 0 || orchestratorBusy ? "Coordinating" : "Ready"}
              </span>
            </div>
            <p className="mt-1 text-[.7rem] text-muted-foreground">
              {activeCount > 0
                ? "Managing worker dependencies and preparing their results for integration."
                : orchestratorBusy
                  ? "Collecting settled worker results and preparing the next integration step."
                  : "Describe a goal in the floating composer or add workers in Hybrid or Manual mode."}
            </p>
          </section>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {view === "overview" ? (
          <div className="flex flex-col gap-2 p-2">
            {visibleModel.workflows.map((group) => (
              <WorkflowSection
                key={group.workflow.id}
                group={group}
                environmentId={environmentId}
                threadId={threadId}
              />
            ))}
            {visibleModel.directAgents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </div>
        ) : view === "history" ? (
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Previous swarms</p>
                <p className="text-xs text-muted-foreground">
                  Completed workers stay here for traceability.
                </p>
              </div>
              {dismissibleIds.size > 0 ? (
                <Button size="xs" variant="ghost-muted" onClick={clearCompleted}>
                  Clean up now
                </Button>
              ) : null}
            </div>
            {historyAgents.length > 0 ? (
              <div className="space-y-3">
                {model.workflows
                  .filter((group) => archivedIds.has(group.workflow.id))
                  .map((group) => (
                    <section
                      key={group.workflow.id}
                      className="rounded-xl border border-border/70 bg-card/40 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">{group.workflow.title}</p>
                          <p className="text-[.7rem] text-muted-foreground">
                            {swarmIntegrationState(group).label} · {workflowMembers(group).length}{" "}
                            workers
                          </p>
                        </div>
                        <span className="font-mono text-[.65rem] text-muted-foreground">
                          {group.workflow.completedAt
                            ? new Date(group.workflow.completedAt).toLocaleString()
                            : "Previous run"}
                        </span>
                      </div>
                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {workflowMembers(group).map((agent) => (
                          <SwarmCard key={agent.id} agent={agent} />
                        ))}
                      </div>
                    </section>
                  ))}
                {historyAgents.some((agent) => agent.parentAgentId === null) ? (
                  <section className="rounded-xl border border-border/70 bg-card/40 p-3">
                    <p className="mb-2 text-sm font-semibold">Manual swarm run</p>
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {historyAgents
                        .filter((agent) => agent.parentAgentId === null)
                        .map((agent) => (
                          <SwarmCard key={agent.id} agent={agent} />
                        ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <History aria-hidden className="size-5" />
                <p className="text-xs">No previous swarm runs yet.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="p-3">
            {activeAgents.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {activeAgents.map((agent) => (
                  <SwarmCard
                    key={agent.id}
                    agent={agent}
                    onMessage={messageAgent}
                    onStop={stopAgent}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                <Bot aria-hidden className="size-7 text-muted-foreground/60" />
                <p className="text-sm font-medium">Swarm is idle</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  In Auto mode, ask the lead to handle a decomposable task. Switch to Hybrid or
                  Manual to launch workers yourself.
                </p>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
      {activeCount > 0 && mode !== "auto" ? (
        <div className="shrink-0 border-t border-border/60 bg-background/85 px-3 py-2 backdrop-blur-xl">
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-[18px] border border-border/80 bg-card/90 p-1.5 shadow-lg">
            <input
              value={broadcast}
              onChange={(event) => setBroadcast(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") askAll();
              }}
              placeholder="Message the orchestrator and all live workers…"
              className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs outline-none"
            />
            <Button size="xs" disabled={!broadcast.trim() || !onCommand} onClick={askAll}>
              <Send aria-hidden className="mr-1 size-3" /> Send
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
