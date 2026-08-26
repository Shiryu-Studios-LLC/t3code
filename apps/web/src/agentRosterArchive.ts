import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { isTerminalSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { latestMeaningfulAgentActivityAt } from "./agentStatus";

export function isSettledAgent(agent: RuntimeSubagent): boolean {
  return isTerminalSubagentStatus(agent.status);
}

export function collectSettledAgentIds(model: AgentPanelModel): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of model.workflows) {
    if (isSettledAgent(group.workflow)) ids.add(group.workflow.id);
    for (const phase of group.phases) {
      for (const member of phase.members) {
        if (isSettledAgent(member)) ids.add(member.id);
      }
    }
    for (const member of group.unphasedMembers) {
      if (isSettledAgent(member)) ids.add(member.id);
    }
  }
  for (const agent of model.directAgents) {
    if (isSettledAgent(agent)) ids.add(agent.id);
  }
  return ids;
}

export function collectDismissibleAgentIds(
  model: AgentPanelModel,
  nowMs: number,
  stalledAfterMs = 10 * 60 * 1000,
): ReadonlySet<string> {
  const ids = new Set(collectSettledAgentIds(model));
  const maybeAddStalled = (agent: RuntimeSubagent) => {
    if (agent.status !== "running" && agent.status !== "pending" && agent.status !== "waiting") {
      return;
    }
    const activityAt = latestMeaningfulAgentActivityAt(agent);
    const latestMs = activityAt ? Date.parse(activityAt) : Number.NaN;
    if (Number.isFinite(latestMs) && nowMs - latestMs >= stalledAfterMs) {
      ids.add(agent.id);
    }
  };

  for (const group of model.workflows) {
    maybeAddStalled(group.workflow);
    for (const phase of group.phases) {
      for (const member of phase.members) maybeAddStalled(member);
    }
    for (const member of group.unphasedMembers) maybeAddStalled(member);
  }
  for (const agent of model.directAgents) maybeAddStalled(agent);
  return ids;
}

/**
 * A terminal workflow coordinator is the orchestrator's terminal signal.
 * Once the coordinator and every visible member are settled, the whole
 * workflow can leave the live roster while its chat/work-log history remains.
 * Direct workers leave independently as soon as they settle; tying their
 * cleanup to the parent turn or to sibling workers leaves finished cards in
 * the active grid during long-running mixed swarms.
 */
export function collectAutoArchiveAgentIds(
  model: AgentPanelModel,
  _parentTurnCompleted = false,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of model.workflows) {
    if (!isSettledAgent(group.workflow)) continue;
    const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
    if (members.some((member) => !isSettledAgent(member))) continue;
    ids.add(group.workflow.id);
    for (const member of members) ids.add(member.id);
  }
  for (const agent of model.directAgents) {
    if (isSettledAgent(agent)) ids.add(agent.id);
  }
  return ids;
}

export function filterArchivedAgents(
  model: AgentPanelModel,
  archivedIds: ReadonlySet<string>,
): AgentPanelModel {
  if (archivedIds.size === 0) return model;

  const workflows = model.workflows
    .filter((group) => !archivedIds.has(group.workflow.id))
    .map((group) => ({
      ...group,
      phases: group.phases.map((phase) => ({
        ...phase,
        members: phase.members.filter((member) => !archivedIds.has(member.id)),
      })),
      unphasedMembers: group.unphasedMembers.filter((member) => !archivedIds.has(member.id)),
    }));
  const directAgents = model.directAgents.filter((agent) => !archivedIds.has(agent.id));

  const visibleAgents = [
    ...workflows.flatMap((group) => [
      group.workflow,
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ]),
    ...directAgents,
  ];
  const runningCount = visibleAgents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  const waitingCount = visibleAgents.filter((agent) => agent.status === "waiting").length;
  const idleCount = visibleAgents.filter((agent) => agent.status === "idle").length;
  const settledCount = visibleAgents.filter(isSettledAgent).length;
  const totalTokens = visibleAgents.reduce(
    (sum, agent) => sum + (agent.usage?.totalTokens ?? 0),
    0,
  );

  return {
    workflows,
    directAgents,
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: visibleAgents.length > 0,
    liveCount: runningCount + waitingCount,
  };
}
