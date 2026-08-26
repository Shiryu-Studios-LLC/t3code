import { describe, expect, it } from "vite-plus/test";
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  collectAutoArchiveAgentIds,
  collectDismissibleAgentIds,
  collectSettledAgentIds,
  filterArchivedAgents,
} from "./agentRosterArchive";

const agent = (id: string, status: RuntimeSubagent["status"]): RuntimeSubagent => ({
  id,
  kind: "subagent",
  title: id,
  role: null,
  model: null,
  effort: null,
  status,
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
  startedAt: "2026-08-25T20:00:00.000Z",
  completedAt: status === "completed" ? "2026-08-25T20:01:00.000Z" : null,
});

function model(): AgentPanelModel {
  const coordinator = { ...agent("workflow", "completed"), kind: "workflow" as const };
  const done = agent("done", "completed");
  const running = agent("running", "running");
  return {
    workflows: [
      {
        workflow: coordinator,
        phases: [
          {
            index: 0,
            title: "Phase 1",
            members: [done, running],
            state: "running",
            activeCount: 1,
            settledCount: 1,
          },
        ],
        unphasedMembers: [],
      },
    ],
    directAgents: [],
    runningCount: 1,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 2,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 1,
  };
}

describe("agent roster archiving", () => {
  it("manual clear selects settled agents but never active agents", () => {
    const ids = collectSettledAgentIds(model());
    expect([...ids]).toContain("done");
    expect([...ids]).toContain("workflow");
    expect([...ids]).not.toContain("running");
  });

  it("does not auto-archive a completed workflow while a member is still active", () => {
    expect([...collectAutoArchiveAgentIds(model())]).toEqual([]);
  });

  it("auto-archives a completed workflow after every member settles", () => {
    const current = model();
    const settledRunning = agent("running", "completed");
    const next: AgentPanelModel = {
      ...current,
      workflows: [
        {
          ...current.workflows[0]!,
          phases: [
            {
              ...current.workflows[0]!.phases[0]!,
              members: [agent("done", "completed"), settledRunning],
              state: "done",
              activeCount: 0,
              settledCount: 2,
            },
          ],
        },
      ],
    };
    expect([...collectAutoArchiveAgentIds(next)].sort()).toEqual(["done", "running", "workflow"]);
  });

  it("auto-archives each settled direct spawn without waiting for the parent turn", () => {
    const directModel: AgentPanelModel = {
      ...model(),
      workflows: [],
      directAgents: [agent("direct-a", "completed"), agent("direct-b", "failed")],
      runningCount: 0,
      settledCount: 2,
      liveCount: 0,
    };
    expect([...collectAutoArchiveAgentIds(directModel)].sort()).toEqual(["direct-a", "direct-b"]);
  });

  it("archives settled direct spawns while preserving active siblings", () => {
    const directModel: AgentPanelModel = {
      ...model(),
      workflows: [],
      directAgents: [agent("direct-a", "completed"), agent("direct-b", "running")],
      runningCount: 1,
      settledCount: 1,
      liveCount: 1,
    };
    expect([...collectAutoArchiveAgentIds(directModel, true)]).toEqual(["direct-a"]);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "auto-archives a %s workflow after every member settles",
    (status) => {
      const current = model();
      const next: AgentPanelModel = {
        ...current,
        workflows: [
          {
            ...current.workflows[0]!,
            workflow: { ...current.workflows[0]!.workflow, status },
            phases: [
              {
                ...current.workflows[0]!.phases[0]!,
                members: [agent("done", "completed"), agent("stopped", "interrupted")],
                state: "done",
                activeCount: 0,
                settledCount: 2,
              },
            ],
          },
        ],
      };
      expect([...collectAutoArchiveAgentIds(next)].sort()).toEqual(["done", "stopped", "workflow"]);
    },
  );

  it("keeps a terminal workflow visible until all of its workers settle", () => {
    const current = model();
    const next: AgentPanelModel = {
      ...current,
      workflows: [
        {
          ...current.workflows[0]!,
          workflow: { ...current.workflows[0]!.workflow, status: "failed" },
        },
      ],
    };
    expect([...collectAutoArchiveAgentIds(next)]).toEqual([]);
  });

  it("filtering archived agents preserves active agents", () => {
    const filtered = filterArchivedAgents(model(), new Set(["done"]));
    expect(filtered.workflows[0]?.phases[0]?.members.map((member) => member.id)).toEqual([
      "running",
    ]);
    expect(filtered.liveCount).toBe(1);
  });

  it("manual dismissal includes long-stalled active agents but not fresh active agents", () => {
    const next = model();
    const stalled = {
      ...agent("stalled", "running"),
      updatedAt: "2026-08-25T19:40:00.000Z",
      startedAt: "2026-08-25T19:30:00.000Z",
      recentActivity: [{ at: "2026-08-25T19:40:00.000Z", summary: "last work" }],
    };
    const fresh = {
      ...agent("fresh", "running"),
      updatedAt: "2026-08-25T19:59:00.000Z",
      startedAt: "2026-08-25T19:30:00.000Z",
      recentActivity: [{ at: "2026-08-25T19:59:00.000Z", summary: "recent work" }],
    };
    const directModel: AgentPanelModel = {
      ...next,
      workflows: [],
      directAgents: [stalled, fresh],
      runningCount: 2,
      settledCount: 0,
      liveCount: 2,
    };
    const ids = collectDismissibleAgentIds(directModel, Date.parse("2026-08-25T20:00:00.000Z"));
    expect([...ids]).toContain("stalled");
    expect([...ids]).not.toContain("fresh");
  });
});
