import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities OpenCode agent overview bridge", () => {
  it("projects collaborative task tools into named task lifecycle activities", () => {
    const event = {
      ...base,
      type: "item.started",
      eventId: EventId.make("evt-opencode-agent"),
      itemId: RuntimeItemId.make("call-mobile-tts"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "task",
        data: {
          tool: "task",
          state: {
            status: "running",
            input: {
              subagent_type: "general",
              prompt: "Implement mobile TTS controls and verify the responsive layout.",
            },
          },
        },
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    expect(activities).toHaveLength(2);
    expect(activities[0]?.kind).toBe("tool.started");
    expect(activities[1]?.kind).toBe("task.started");
    const payload = activities[1]?.payload as Record<string, unknown>;
    expect(payload.taskId).toBe("call-mobile-tts");
    expect(payload.agentKind).toBe("agent");
    expect(payload.title).toBe("mobile TTS controls and verify the responsive layout");
    expect(payload.role).toBe("OpenCode subagent");
  });

  it("preserves the OpenCode child session id as the agent run handle", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-opencode-child-session"),
      itemId: RuntimeItemId.make("call-child-session"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Backend validation",
        data: {
          tool: "task",
          state: {
            status: "running",
            input: { prompt: "Validate backend behavior" },
            metadata: { sessionId: "ses_child_123", parentSessionId: "ses_parent" },
          },
        },
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const payload = activities.find((activity) => activity.kind === "task.progress")
      ?.payload as Record<string, unknown>;
    expect(payload.runHandles).toEqual({ runId: "ses_child_123" });
  });

  it("does not mark a background OpenCode child complete when only the launch tool settles", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-opencode-background-launch-complete"),
      itemId: RuntimeItemId.make("call-background-child"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Background worker",
        detail: "Background task launched",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { prompt: "Run long validation" },
            output: "Task launched",
            metadata: {
              background: true,
              sessionId: "ses_background_child",
              parentSessionId: "ses_parent",
            },
          },
        },
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("tool.completed");
    expect(activities.some((activity) => activity.kind === "task.completed")).toBe(false);
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});
