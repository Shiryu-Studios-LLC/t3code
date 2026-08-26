import { describe, expect, it } from "vite-plus/test";
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  classifyAgentProviderIssue,
  deriveAgentHealth,
  formatAgentProgressSummary,
  isAgentProgressStatusQuery,
} from "./agentStatus";

const agent = (patch: Partial<RuntimeSubagent> = {}): RuntimeSubagent => ({
  id: "a1",
  kind: "subagent",
  title: "Backend Validation",
  role: null,
  model: "opencode/test",
  effort: null,
  status: "running",
  activationCount: 1,
  usage: null,
  progress: "Checking API handlers",
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
  recentActivity: [{ at: "2026-08-25T20:00:00.000Z", summary: "Checking API handlers" }],
  firstSeenAt: "2026-08-25T19:59:00.000Z",
  startedAt: "2026-08-25T19:59:00.000Z",
  completedAt: null,
  updatedAt: "2026-08-25T20:00:00.000Z",
  ...patch,
});

const model = (directAgents: RuntimeSubagent[]): AgentPanelModel => ({
  workflows: [],
  directAgents,
  runningCount: directAgents.filter((a) => a.status === "running").length,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: directAgents.length > 0,
  liveCount: directAgents.length,
});

describe("agent status queries", () => {
  it.each(["progress update", "where are we at?", "what are the agents doing?", "agent status"])(
    "recognizes %s",
    (text) => expect(isAgentProgressStatusQuery(text)).toBe(true),
  );
  it("does not treat implementation prompts as status checks", () => {
    expect(isAgentProgressStatusQuery("fix the backend and run tests")).toBe(false);
  });
});

describe("agent health", () => {
  it("marks five minutes silent as possibly stalled and ten minutes as stalled", () => {
    expect(deriveAgentHealth(agent(), Date.parse("2026-08-25T20:06:00.000Z")).state).toBe(
      "possibly-stalled",
    );
    expect(deriveAgentHealth(agent(), Date.parse("2026-08-25T20:11:00.000Z")).state).toBe(
      "stalled",
    );
  });
  it("classifies rate limits and retry-after", () => {
    expect(classifyAgentProviderIssue("HTTP 429 rate limit exceeded; retry-after: 42s")).toEqual({
      kind: "rate-limit",
      label: "Rate limited",
      retryAfter: "42s",
    });
  });
  it("formats local status without contacting the provider", () => {
    const text = formatAgentProgressSummary(
      model([agent()]),
      Date.parse("2026-08-25T20:11:00.000Z"),
    );
    expect(text).toContain("Backend Validation");
    expect(text).toContain("Stalled");
    expect(text).toContain("last activity 11m ago");
  });
});
