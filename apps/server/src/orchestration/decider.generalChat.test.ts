import {
  CommandId,
  EventId,
  GENERAL_CHAT_PROJECT_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-12T21:55:00.000Z";
const targetProjectId = ProjectId.make("project-attached");
const threadId = ThreadId.make("thread-general-chat");

function projectCreated(sequence: number, projectId: ProjectId, root: string): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`evt-project-${sequence}`),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make(`cmd-project-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-project-${sequence}`),
    metadata: {},
    payload: {
      projectId,
      title: projectId === GENERAL_CHAT_PROJECT_ID ? "General Chat" : "Attached",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

const threadCreated = (sequence: number, projectId: ProjectId): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`evt-thread-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.created",
  occurredAt: now,
  commandId: CommandId.make(`cmd-thread-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-thread-${sequence}`),
  metadata: {},
  payload: {
    threadId,
    projectId,
    title: "General chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("General Chat project attachment", (it) => {
  it.effect("moves a General Chat thread into an existing project", () =>
    Effect.gen(function* () {
      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(
        readModel,
        projectCreated(1, GENERAL_CHAT_PROJECT_ID, "/tmp/general-chat"),
      );
      readModel = yield* projectEvent(
        readModel,
        projectCreated(2, targetProjectId, "/tmp/attached"),
      );
      readModel = yield* projectEvent(readModel, threadCreated(3, GENERAL_CHAT_PROJECT_ID));

      const decided = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-attach-project"),
          threadId,
          projectId: targetProjectId,
          branch: null,
          worktreePath: null,
        },
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("thread.meta-updated");
      expect(event.payload).toMatchObject({ projectId: targetProjectId });

      const updated = yield* projectEvent(readModel, { ...event, sequence: 4 });
      expect(updated.threads[0]?.projectId).toBe(targetProjectId);
    }),
  );

  it.effect("does not let ordinary project threads jump between projects", () =>
    Effect.gen(function* () {
      const otherProjectId = ProjectId.make("project-other");
      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(readModel, projectCreated(1, targetProjectId, "/tmp/a"));
      readModel = yield* projectEvent(readModel, projectCreated(2, otherProjectId, "/tmp/b"));
      readModel = yield* projectEvent(readModel, threadCreated(3, targetProjectId));

      const error = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-illegal-project-move"),
          threadId,
          projectId: otherProjectId,
        },
      }).pipe(Effect.flip);
      expect(error.message).toContain("General Chat");
    }),
  );
});
