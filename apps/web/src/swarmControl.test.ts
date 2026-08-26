import { describe, expect, it } from "vite-plus/test";

import {
  buildSwarmCommand,
  canLaunchSwarmAgent,
  swarmIntegrationState,
} from "./components/AgentsPanel";
import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

describe("swarm controls", () => {
  it("allows manual and hybrid launches until the configured 15-agent ceiling", () => {
    expect(canLaunchSwarmAgent("hybrid", 14, 15, true)).toBe(true);
    expect(canLaunchSwarmAgent("manual", 14, 15, true)).toBe(true);
    expect(canLaunchSwarmAgent("hybrid", 15, 15, true)).toBe(false);
    expect(canLaunchSwarmAgent("manual", 16, 15, true)).toBe(false);
  });

  it("keeps Auto orchestrator-owned and disables launches without a command channel", () => {
    expect(canLaunchSwarmAgent("auto", 0, 15, true)).toBe(false);
    expect(canLaunchSwarmAgent("hybrid", 0, 15, false)).toBe(false);
  });

  it("builds an explicit background launch request with workspace isolation", () => {
    const command = buildSwarmCommand("launch", {
      title: "API audit",
      task: "Review the API boundary and report regressions.",
      workspace: "worktree",
    });
    expect(command).toContain("Launch exactly one new background child agent");
    expect(command).toContain("Agent title: API audit");
    expect(command).toContain("isolated git worktree");
    expect(command).toContain("Review the API boundary");
  });

  it("builds non-destructive summarize and broadcast requests", () => {
    expect(buildSwarmCommand("summarize", {})).toContain("Do not cancel or pause any workers");
    expect(buildSwarmCommand("ask-all", { message: "Re-run focused tests." })).toContain(
      "Re-run focused tests.",
    );
  });
});

function agent(overrides: Partial<RuntimeSubagent>): RuntimeSubagent {
  return {
    id: "agent-1",
    kind: "workflow_agent",
    title: "Worker",
    role: null,
    model: null,
    effort: null,
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: "workflow-1",
    agentIndex: 0,
    phaseIndex: 0,
    phaseTitle: "Build",
    attempt: 1,
    workflowName: "Run",
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function group(
  worker: RuntimeSubagent,
  workflowStatus: RuntimeSubagent["status"],
): AgentPanelWorkflowGroup {
  return {
    workflow: agent({
      id: "workflow-1",
      kind: "workflow",
      parentAgentId: null,
      status: workflowStatus,
    }),
    phases: [
      {
        index: 0,
        title: "Build",
        members: [worker],
        state: worker.status === "completed" ? "done" : "running",
        activeCount: worker.status === "running" ? 1 : 0,
        settledCount: worker.status === "completed" || worker.status === "failed" ? 1 : 0,
      },
    ],
    unphasedMembers: [],
  };
}

describe("swarm integration presentation", () => {
  it("shows dependency execution while a phase has live workers", () => {
    expect(swarmIntegrationState(group(agent({ status: "running" }), "running"))).toMatchObject({
      label: "Executing · Build",
      tone: "working",
    });
  });

  it("keeps the orchestrator visibly busy while settled worker results are being collected", () => {
    expect(swarmIntegrationState(group(agent({ status: "completed" }), "running"))).toMatchObject({
      label: "Collecting worker results",
      tone: "working",
    });
    expect(swarmIntegrationState(group(agent({ status: "failed" }), "running")).tone).toBe(
      "failed",
    );
    expect(swarmIntegrationState(group(agent({ status: "completed" }), "completed")).tone).toBe(
      "complete",
    );
  });
});
