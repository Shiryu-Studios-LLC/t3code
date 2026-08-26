import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

export const ProviderSwarmWorkspaceStrategy = Schema.Literals(["shared", "worktree"]);
export type ProviderSwarmWorkspaceStrategy = typeof ProviderSwarmWorkspaceStrategy.Type;

export const ProviderSwarmLaunchAgentInput = Schema.Struct({
  threadId: ThreadId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  workspaceStrategy: ProviderSwarmWorkspaceStrategy,
  /** Repository checkout used as the source when creating an isolated worktree. */
  projectCwd: Schema.optional(TrimmedNonEmptyString),
  /** Base branch/ref for isolated worktree creation. */
  baseRefName: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
});
export type ProviderSwarmLaunchAgentInput = typeof ProviderSwarmLaunchAgentInput.Type;

export const ProviderSwarmLaunchAgentResolvedInput = Schema.Struct({
  threadId: ThreadId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  directory: Schema.optional(TrimmedNonEmptyString),
  workspaceStrategy: ProviderSwarmWorkspaceStrategy,
  modelSelection: Schema.optional(ModelSelection),
});
export type ProviderSwarmLaunchAgentResolvedInput =
  typeof ProviderSwarmLaunchAgentResolvedInput.Type;

export const ProviderSwarmLaunchAgentResult = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  sessionId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  workspaceStrategy: ProviderSwarmWorkspaceStrategy,
  workspacePath: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSwarmLaunchAgentResult = typeof ProviderSwarmLaunchAgentResult.Type;

export const ProviderSwarmMessageAgentInput = Schema.Struct({
  threadId: ThreadId,
  agentId: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
});
export type ProviderSwarmMessageAgentInput = typeof ProviderSwarmMessageAgentInput.Type;

export const ProviderSwarmStopAgentInput = Schema.Struct({
  threadId: ThreadId,
  agentId: TrimmedNonEmptyString,
});
export type ProviderSwarmStopAgentInput = typeof ProviderSwarmStopAgentInput.Type;

export class ProviderSwarmControlError extends Schema.TaggedErrorClass<ProviderSwarmControlError>()(
  "ProviderSwarmControlError",
  {
    threadId: ThreadId,
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `${this.operation} failed for thread ${this.threadId}: ${this.detail}`;
  }
}

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedErrorClass<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
