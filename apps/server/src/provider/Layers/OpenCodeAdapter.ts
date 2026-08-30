import {
  type AgentTeamMode,
  DEFAULT_AGENT_TEAM_MAX_CONCURRENCY,
  MAX_AGENT_TEAM_MAX_CONCURRENCY,
  MIN_AGENT_TEAM_MAX_CONCURRENCY,
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSwarmLaunchAgentResolvedInput,
  type ProviderSwarmLaunchAgentResult,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { externalMcpServersForOpenCode } from "../../mcp/ExternalMcpProviderConfig.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeChildTaskBinding {
  readonly taskId: string;
  readonly childSessionId: string;
  readonly title: string;
  readonly description: string;
  readonly turnId: TurnId | undefined;
  readonly background: boolean;
  readonly direct: boolean;
  readonly workspaceStrategy: "shared" | "worktree";
  readonly workspacePath: string | undefined;
  model: string | null;
  latestResult: string | null;
  parentTerminal: boolean;
  childTerminal: boolean;
}

function openCodeChildRunHandles(binding: OpenCodeChildTaskBinding) {
  return {
    runId: binding.childSessionId,
    ...(binding.workspacePath ? { workspacePath: binding.workspacePath } : {}),
  };
}

const MAX_BUFFERED_CHILD_EVENTS_PER_SESSION = 32;
const MAX_TRACKED_CHILD_SESSIONS = 64;
const MAX_SEEN_OPENCODE_EVENT_IDS = 4096;

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function openCodeTaskStateMetadata(
  part: Extract<Part, { type: "tool" }>,
): Record<string, unknown> | undefined {
  return asUnknownRecord("metadata" in part.state ? part.state.metadata : undefined);
}

/**
 * OpenCode's native task tool stamps the child session id into
 * state.metadata.sessionId immediately after creating the subagent session.
 * Keep a few compatibility spellings because older/newer provider builds have
 * used slightly different casing in exported task payloads.
 */
export function openCodeTaskChildSessionId(
  part: Extract<Part, { type: "tool" }>,
): string | undefined {
  const stateMetadata = openCodeTaskStateMetadata(part);
  const partMetadata = asUnknownRecord(part.metadata);
  for (const record of [stateMetadata, partMetadata]) {
    if (!record) continue;
    for (const key of [
      "sessionId",
      "sessionID",
      "session_id",
      "childSessionId",
      "childSessionID",
      "child_session_id",
    ] as const) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function openCodeTaskIsBackground(part: Extract<Part, { type: "tool" }>): boolean {
  return openCodeTaskStateMetadata(part)?.background === true;
}

function openCodeTaskDescription(part: Extract<Part, { type: "tool" }>): string {
  const input = asUnknownRecord(part.state.input);
  for (const key of ["description", "prompt", "task", "instruction"] as const) {
    const value = nonEmptyString(input?.[key]);
    if (value) return value;
  }
  if (part.state.status === "running") {
    const title = nonEmptyString(part.state.title);
    if (title) return title;
  }
  return "OpenCode subagent";
}

function openCodeTaskTitle(part: Extract<Part, { type: "tool" }>): string {
  const title =
    part.state.status === "running" || part.state.status === "completed"
      ? nonEmptyString(part.state.title)
      : undefined;
  return title ?? openCodeTaskDescription(part).split(/\r?\n/, 1)[0]!.slice(0, 120);
}

function openCodeTaskModel(part: Extract<Part, { type: "tool" }>): string | null {
  const model = asUnknownRecord(openCodeTaskStateMetadata(part)?.model);
  const providerID = nonEmptyString(model?.providerID);
  const modelID = nonEmptyString(model?.modelID ?? model?.id);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
}

function openCodeEventId(event: OpenCodeSubscribedEvent): string | undefined {
  return "id" in event ? nonEmptyString(event.id) : undefined;
}

function openCodeSessionParentId(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.created" && event.type !== "session.updated") return undefined;
  return nonEmptyString(event.properties.info.parentID);
}

function openCodeSessionModel(event: OpenCodeSubscribedEvent): string | null {
  if (event.type !== "session.created" && event.type !== "session.updated") return null;
  const model = event.properties.info.model;
  return model?.providerID && model.id ? `${model.providerID}/${model.id}` : null;
}

function openCodeSessionErrorDiagnostic(error: unknown): string {
  const record = asUnknownRecord(error);
  const data = asUnknownRecord(record?.data);
  const message = nonEmptyString(data?.message) ?? nonEmptyString(record?.message);
  const statusCode =
    typeof data?.statusCode === "number"
      ? data.statusCode
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : undefined;
  const headers = asUnknownRecord(data?.responseHeaders);
  const retryAfter =
    nonEmptyString(headers?.["retry-after"]) ?? nonEmptyString(headers?.["Retry-After"]);
  return (
    [
      statusCode ? `HTTP ${statusCode}` : undefined,
      message,
      retryAfter ? `Retry-After ${retryAfter}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(": ") || "OpenCode child session failed."
  );
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);
  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly childTaskBySessionId: Map<string, OpenCodeChildTaskBinding>;
  readonly childSessionIdByTaskId: Map<string, string>;
  readonly knownChildSessionIds: Set<string>;
  readonly bufferedChildEvents: Map<string, Array<OpenCodeSubscribedEvent>>;
  readonly seenOpenCodeEventIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly getAgentTeamSettings?: () => Effect.Effect<{
    readonly mode: AgentTeamMode;
    readonly maxConcurrency: number;
  }>;
}

export function buildOpenCodeAgentTeamInstruction(input: {
  readonly mode: AgentTeamMode;
  readonly maxConcurrency: number;
}): string | undefined {
  if (input.mode === "off") {
    return undefined;
  }

  const boundedConcurrency = Math.max(
    MIN_AGENT_TEAM_MAX_CONCURRENCY,
    Math.min(MAX_AGENT_TEAM_MAX_CONCURRENCY, Math.trunc(input.maxConcurrency)),
  );
  const delegationRule =
    input.mode === "always"
      ? "For every non-trivial task, delegate at least two independent subtasks to child agents before doing the final integration yourself."
      : "Before working, decide whether the request has at least two useful independent workstreams. If it does, delegate them to child agents in parallel; if it does not, work normally without manufacturing unnecessary delegation.";

  return [
    "[T3 Agent Team Mode]",
    "You are the lead/orchestrator for this conversation. OpenCode child agents are available through the native task/subagent tools.",
    delegationRule,
    `Never have more than ${boundedConcurrency} child agents running concurrently. Start independent workers before waiting for earlier workers so genuinely parallel work overlaps.`,
    "When the native task tool exposes a background option, use background=true for independent workstreams so launching one worker does not block launching the next. After fan-out, keep coordinating and wait for the child completion notifications/results before final integration. If background execution is unavailable, issue independent task calls together whenever the runtime supports parallel tool calls.",
    "Give each worker a narrow objective, explicit file/area ownership when edits are involved, and ask it to report findings, changes, and verification back to you.",
    "Avoid having multiple workers edit the same files concurrently unless the provider gives them isolated workspaces. Prefer read-only research/review workers when ownership would overlap.",
    "Messages beginning with [T3 Swarm Control] are explicit operator controls. Follow the requested launch/message/stop/broadcast/summarize action exactly instead of re-planning it as a normal user task.",
    "For a Swarm Control launch that asks for an isolated Git worktree, create or use a distinct worktree for that worker before it edits files. If isolation cannot be created safely, report that limitation instead of silently putting concurrent editing agents in the same checkout.",
    "For a Swarm Control launch, start the requested worker in the background and return control promptly after the launch is confirmed; do not wait for that worker before accepting another operator launch command.",
    "You remain responsible for integrating worker results, resolving conflicts, running or delegating final verification, and returning one consolidated final answer in this original conversation.",
    "Do not give the user a final completion answer until every delegated worker has reached a terminal state or you have explicitly handled its failure/cancellation. Recombine successful and partial results yourself; never wait forever on an already-terminal child.",
    "Do not ask the user to open or manage separate chats for the child agents.",
    "[/T3 Agent Team Mode]",
  ].join("\n");
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Background child sessions can outlive the parent task invocation on an
  // externally managed OpenCode server. Stop them explicitly before closing
  // the parent so a T3 session stop/restart never leaves hidden workers
  // mutating the workspace after the user believes the run ended.
  yield* Effect.forEach(
    [...context.childTaskBySessionId.values()].filter((binding) => !binding.childTerminal),
    (binding) =>
      runOpenCodeSdk("session.abort.child", () =>
        context.client.session.abort({ sessionID: binding.childSessionId }),
      ).pipe(Effect.ignore({ log: true })),
    { concurrency: "unbounded", discard: true },
  );

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    // Manual launch requests can arrive concurrently over separate RPCs. Keep
    // the capacity check and child registration in one critical section so
    // two callers cannot both observe the final free slot and exceed the
    // configured (and globally bounded) agent ceiling.
    const swarmLaunchMutex = yield* Semaphore.make(1);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* runOpenCodeSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore({ log: true }));
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const emitChildTaskProgress = Effect.fn("emitChildTaskProgress")(function* (
      context: OpenCodeSessionContext,
      binding: OpenCodeChildTaskBinding,
      input: {
        readonly summary?: string;
        readonly lastToolName?: string;
        readonly error?: string;
        readonly status?: "pending" | "running" | "waiting" | "idle";
        readonly typedUsage?: {
          readonly totalTokens: number;
          readonly inputTokens?: number;
          readonly cachedInputTokens?: number;
          readonly outputTokens?: number;
          readonly reasoningOutputTokens?: number;
          readonly toolUses?: number;
          readonly durationMs?: number;
        };
        readonly createdAt?: string;
        readonly raw?: unknown;
      },
    ) {
      if (binding.childTerminal) return;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: binding.turnId,
          createdAt: input.createdAt,
          raw: input.raw,
        })),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(binding.taskId),
          taskType: "opencode_subagent",
          description: binding.description,
          title: binding.title,
          role: "OpenCode subagent",
          status: input.status ?? "running",
          runHandles: openCodeChildRunHandles(binding),
          ...(binding.model ? { model: binding.model } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.lastToolName ? { lastToolName: input.lastToolName } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.typedUsage ? { typedUsage: input.typedUsage } : {}),
        },
      });
    });

    const emitChildToolProgress = Effect.fn("emitChildToolProgress")(function* (
      context: OpenCodeSessionContext,
      binding: OpenCodeChildTaskBinding,
      input: {
        readonly toolName: string;
        readonly toolUseId?: string;
        readonly summary?: string;
        readonly createdAt?: string;
        readonly raw?: unknown;
      },
    ) {
      if (binding.childTerminal) return;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: binding.turnId,
          createdAt: input.createdAt,
          raw: input.raw,
        })),
        type: "tool.progress",
        payload: {
          taskId: RuntimeTaskId.make(binding.taskId),
          toolName: input.toolName,
          ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
        },
      });
    });

    const settleChildTask = Effect.fn("settleChildTask")(function* (
      context: OpenCodeSessionContext,
      binding: OpenCodeChildTaskBinding,
      input: {
        readonly status: "completed" | "failed" | "stopped";
        readonly summary?: string;
        readonly createdAt?: string;
        readonly raw?: unknown;
      },
    ) {
      if (binding.childTerminal) return;
      binding.childTerminal = true;
      const updatedStatus =
        input.status === "completed"
          ? ("completed" as const)
          : input.status === "failed"
            ? ("failed" as const)
            : ("interrupted" as const);
      if (binding.direct) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: binding.turnId,
            createdAt: input.createdAt,
            raw: input.raw,
          })),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(binding.taskId),
            taskType: "opencode_subagent",
            status: input.status,
            title: binding.title,
            role: "OpenCode subagent",
            runHandles: openCodeChildRunHandles(binding),
            ...(binding.model ? { model: binding.model } : {}),
            ...(binding.latestResult || input.summary
              ? { summary: binding.latestResult ?? input.summary }
              : {}),
          },
        });
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: binding.turnId,
          createdAt: input.createdAt,
          raw: input.raw,
        })),
        // Child idle/error is authoritative lifecycle state, but the parent
        // task wrapper still owns the final task result text. Use an update
        // here so a later parent task.completed can enrich the card with the
        // actual returned result instead of being masked by a generic child
        // completion summary.
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.make(binding.taskId),
          taskType: "opencode_subagent",
          status: updatedStatus,
          description: binding.description,
          title: binding.title,
          role: "OpenCode subagent",
          runHandles: openCodeChildRunHandles(binding),
          ...(binding.model ? { model: binding.model } : {}),
          ...(updatedStatus === "failed" && input.summary ? { error: input.summary } : {}),
          ...(input.createdAt ? { endedAt: input.createdAt } : {}),
        },
      });
    });

    const rememberSeenOpenCodeEvent = (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) => {
      const eventId = openCodeEventId(event);
      if (!eventId) return false;
      if (context.seenOpenCodeEventIds.has(eventId)) return true;
      context.seenOpenCodeEventIds.add(eventId);
      if (context.seenOpenCodeEventIds.size > MAX_SEEN_OPENCODE_EVENT_IDS) {
        const oldest = context.seenOpenCodeEventIds.values().next().value;
        if (typeof oldest === "string") context.seenOpenCodeEventIds.delete(oldest);
      }
      return false;
    };

    const bufferChildEvent = (
      context: OpenCodeSessionContext,
      childSessionId: string,
      event: OpenCodeSubscribedEvent,
    ) => {
      if (!context.knownChildSessionIds.has(childSessionId)) return;
      const existing = context.bufferedChildEvents.get(childSessionId) ?? [];
      existing.push(event);
      if (existing.length > MAX_BUFFERED_CHILD_EVENTS_PER_SESSION) {
        existing.splice(0, existing.length - MAX_BUFFERED_CHILD_EVENTS_PER_SESSION);
      }
      context.bufferedChildEvents.set(childSessionId, existing);
      if (context.bufferedChildEvents.size > MAX_TRACKED_CHILD_SESSIONS) {
        const oldest = context.bufferedChildEvents.keys().next().value;
        if (typeof oldest === "string" && oldest !== childSessionId) {
          context.bufferedChildEvents.delete(oldest);
        }
      }
    };

    const handleChildSubscribedEvent = Effect.fn("handleChildSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      binding: OpenCodeChildTaskBinding,
      event: OpenCodeSubscribedEvent,
    ) {
      const createdAt = yield* nowIso;
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          binding.model = openCodeSessionModel(event) ?? binding.model;
          yield* emitChildTaskProgress(context, binding, {
            summary: "Child session active",
            createdAt,
            raw: event,
          });
          break;
        }
        case "session.status": {
          if (event.properties.status.type === "retry") {
            yield* emitChildTaskProgress(context, binding, {
              summary: "Retrying provider request",
              error: event.properties.status.message,
              status: "running",
              createdAt,
              raw: event,
            });
          } else if (event.properties.status.type === "busy") {
            yield* emitChildTaskProgress(context, binding, {
              summary: "Working",
              status: "running",
              createdAt,
              raw: event,
            });
          } else if (event.properties.status.type === "idle") {
            yield* settleChildTask(context, binding, {
              status: "completed",
              summary: "Child session completed",
              createdAt,
              raw: event,
            });
          }
          break;
        }
        case "session.idle": {
          yield* settleChildTask(context, binding, {
            status: "completed",
            summary: "Child session completed",
            createdAt,
            raw: event,
          });
          break;
        }
        case "session.error": {
          yield* settleChildTask(context, binding, {
            status: "failed",
            summary: openCodeSessionErrorDiagnostic(event.properties.error),
            createdAt,
            raw: event,
          });
          break;
        }
        case "session.deleted": {
          yield* settleChildTask(context, binding, {
            status: "stopped",
            summary: "Child session ended before the parent task settled",
            createdAt,
            raw: event,
          });
          break;
        }
        case "message.updated": {
          const info = event.properties.info;
          if (info.role === "assistant") {
            const error = info.error ? openCodeSessionErrorDiagnostic(info.error) : undefined;
            yield* emitChildTaskProgress(context, binding, {
              summary: error ? "Provider reported an error" : "Generating response",
              ...(error ? { error } : {}),
              createdAt,
              raw: event,
            });
          }
          break;
        }
        case "message.part.delta": {
          yield* emitChildTaskProgress(context, binding, {
            summary: "Generating response",
            createdAt,
            raw: event,
          });
          break;
        }
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.type === "tool") {
            yield* emitChildToolProgress(context, binding, {
              toolName: part.tool,
              toolUseId: part.callID,
              summary:
                part.state.status === "error"
                  ? "Tool failed; agent may recover"
                  : part.state.status === "completed"
                    ? "Tool completed"
                    : "Tool running",
              createdAt,
              raw: event,
            });
            yield* emitChildTaskProgress(context, binding, {
              summary:
                part.state.status === "error"
                  ? `Tool ${part.tool} failed; continuing`
                  : `Using ${part.tool}`,
              lastToolName: part.tool,
              createdAt,
              raw: event,
            });
          } else if (part.type === "step-finish") {
            const tokens = part.tokens;
            yield* emitChildTaskProgress(context, binding, {
              summary: "Completed an agent step",
              typedUsage: {
                totalTokens:
                  tokens.total ??
                  tokens.input +
                    tokens.output +
                    tokens.reasoning +
                    tokens.cache.read +
                    tokens.cache.write,
                inputTokens: tokens.input,
                cachedInputTokens: tokens.cache.read,
                outputTokens: tokens.output,
                reasoningOutputTokens: tokens.reasoning,
              },
              createdAt,
              raw: event,
            });
          } else if (part.type === "retry") {
            yield* emitChildTaskProgress(context, binding, {
              summary: `Retrying provider request (attempt ${part.attempt})`,
              error: openCodeSessionErrorDiagnostic(part.error),
              createdAt,
              raw: event,
            });
          } else if (part.type === "reasoning") {
            yield* emitChildTaskProgress(context, binding, {
              summary: "Reasoning",
              createdAt,
              raw: event,
            });
          } else if (part.type === "text") {
            const resultText = trimText(part.text);
            if (resultText) binding.latestResult = resultText;
            yield* emitChildTaskProgress(context, binding, {
              summary: "Preparing result",
              createdAt,
              raw: event,
            });
          }
          break;
        }
        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Waiting for permission",
            status: "waiting",
            createdAt,
            raw: event,
          });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: binding.turnId,
              requestId: event.properties.id,
              createdAt,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail: `${binding.title}: ${
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission
              }`,
              args: event.properties.metadata,
            },
          });
          break;
        }
        case "permission.replied": {
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: binding.turnId,
              requestId: event.properties.requestID,
              createdAt,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          yield* emitChildTaskProgress(context, binding, {
            summary: "Permission resolved",
            status: "running",
            createdAt,
            raw: event,
          });
          break;
        }
        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Waiting for your answer",
            status: "waiting",
            createdAt,
            raw: event,
          });
          const questions = normalizeQuestionRequest(event.properties).map((question) => ({
            ...question,
            header: `${binding.title}: ${question.header}`.slice(0, 120),
          }));
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: binding.turnId,
              requestId: event.properties.id,
              createdAt,
              raw: event,
            })),
            type: "user-input.requested",
            payload: { questions },
          });
          break;
        }
        case "question.replied":
        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emitChildTaskProgress(context, binding, {
            summary: "User input resolved",
            status: "running",
            createdAt,
            raw: event,
          });
          break;
        }
        case "session.next.step.started": {
          const model = event.properties.model;
          binding.model = `${model.providerID}/${model.id}`;
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: `Agent step started (${event.properties.agent})`,
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.step.ended": {
          const tokens = event.properties.tokens;
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Agent step completed",
            typedUsage: {
              totalTokens:
                tokens.input +
                tokens.output +
                tokens.reasoning +
                tokens.cache.read +
                tokens.cache.write,
              inputTokens: tokens.input,
              cachedInputTokens: tokens.cache.read,
              outputTokens: tokens.output,
              reasoningOutputTokens: tokens.reasoning,
            },
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.step.failed": {
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Agent step failed; waiting for OpenCode to recover or terminate",
            error: event.properties.error.message,
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.reasoning.started":
        case "session.next.reasoning.delta":
        case "session.next.reasoning.ended": {
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Reasoning",
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.text.started":
        case "session.next.text.delta":
        case "session.next.text.ended": {
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: "Generating response",
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.tool.called":
        case "session.next.tool.progress":
        case "session.next.tool.success":
        case "session.next.tool.failed": {
          const properties = event.properties;
          const toolName =
            event.type === "session.next.tool.called" ? event.properties.tool : "Tool";
          const eventAt = isoFromEpochMs(properties.timestamp);
          yield* emitChildToolProgress(context, binding, {
            toolName,
            toolUseId: properties.callID,
            summary:
              event.type === "session.next.tool.failed"
                ? "Tool failed; agent may recover"
                : event.type === "session.next.tool.success"
                  ? "Tool completed"
                  : "Tool activity",
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          yield* emitChildTaskProgress(context, binding, {
            summary: `Tool activity: ${toolName}`,
            lastToolName: toolName,
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        case "session.next.retried": {
          const eventAt = isoFromEpochMs(event.properties.timestamp);
          yield* emitChildTaskProgress(context, binding, {
            summary: `Retrying provider request (attempt ${event.properties.attempt})`,
            error: openCodeSessionErrorDiagnostic(event.properties.error),
            ...(eventAt ? { createdAt: eventAt } : {}),
            raw: event,
          });
          break;
        }
        default:
          break;
      }
    });

    const registerChildTaskBinding = Effect.fn("registerChildTaskBinding")(function* (
      context: OpenCodeSessionContext,
      part: Extract<Part, { type: "tool" }>,
      turnId: TurnId | undefined,
    ) {
      if (toToolLifecycleItemType(part.tool) !== "collab_agent_tool_call") return;
      const childSessionId = openCodeTaskChildSessionId(part);
      if (!childSessionId) return;
      context.knownChildSessionIds.add(childSessionId);
      const existing = context.childTaskBySessionId.get(childSessionId);
      const binding: OpenCodeChildTaskBinding = existing ?? {
        taskId: part.callID,
        childSessionId,
        title: openCodeTaskTitle(part),
        description: openCodeTaskDescription(part),
        turnId,
        background: openCodeTaskIsBackground(part),
        direct: false,
        workspaceStrategy: "shared",
        workspacePath: undefined,
        model: openCodeTaskModel(part),
        latestResult: null,
        parentTerminal: false,
        childTerminal: false,
      };
      binding.model = openCodeTaskModel(part) ?? binding.model;
      if (part.state.status === "completed" || part.state.status === "error") {
        binding.parentTerminal = true;
      }
      context.childTaskBySessionId.set(childSessionId, binding);
      context.childSessionIdByTaskId.set(part.callID, childSessionId);
      const buffered = context.bufferedChildEvents.get(childSessionId) ?? [];
      context.bufferedChildEvents.delete(childSessionId);
      yield* Effect.forEach(buffered, (bufferedEvent) =>
        handleChildSubscribedEvent(context, binding, bufferedEvent),
      );
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId = openCodeEventSessionId(event);
      if (rememberSeenOpenCodeEvent(context, event)) {
        return;
      }

      const sessionParentId = openCodeSessionParentId(event);
      if (
        payloadSessionId &&
        payloadSessionId !== context.openCodeSessionId &&
        sessionParentId === context.openCodeSessionId
      ) {
        context.knownChildSessionIds.add(payloadSessionId);
        const existingBinding = context.childTaskBySessionId.get(payloadSessionId);
        if (existingBinding) {
          existingBinding.model = openCodeSessionModel(event) ?? existingBinding.model;
        }
      }

      if (payloadSessionId !== context.openCodeSessionId) {
        if (!payloadSessionId) return;
        const binding = context.childTaskBySessionId.get(payloadSessionId);
        if (binding) {
          yield* writeNativeEventBestEffort(context.session.threadId, {
            observedAt: yield* nowIso,
            event: {
              provider: PROVIDER,
              threadId: context.session.threadId,
              providerThreadId: payloadSessionId,
              childTaskId: binding.taskId,
              type: event.type,
              payload: event,
            },
          });
          yield* handleChildSubscribedEvent(context, binding, event);
        } else {
          bufferChildEvent(context, payloadSessionId, event);
        }
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.type) {
        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }

        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "tool") {
            yield* registerChildTaskBinding(context, part, turnId);
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail:
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            context.activeTurnId = undefined;
            yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          context.activeTurnId = undefined;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: "t3-code",
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: {
                        Authorization: mcpSession.authorizationHeader,
                      },
                      oauth: false,
                    },
                  }),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not register T3 Code MCP session with OpenCode", {
                      cause,
                    }),
                  ),
                );
              }
              if (!server.external) {
                yield* Effect.forEach(
                  externalMcpServersForOpenCode(input.threadId),
                  (externalMcpServer) =>
                    runOpenCodeSdk("mcp.add", () => client.mcp.add(externalMcpServer)).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Could not register external MCP server with OpenCode", {
                          cause,
                        }),
                      ),
                    ),
                  { discard: true },
                );
              } else {
                yield* Effect.forEach(
                  externalMcpServersForOpenCode(input.threadId).filter(
                    (externalMcpServer) => externalMcpServer.config.type === "remote",
                  ),
                  (externalMcpServer) =>
                    runOpenCodeSdk("mcp.add", () => client.mcp.add(externalMcpServer)).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Could not register external MCP server with OpenCode", {
                          cause,
                        }),
                      ),
                    ),
                  { discard: true },
                );
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    ...(input.title ? { title: input.title } : {}),
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race — clean up. Only abort the remote
          // session if we created it here; a resumed one is shared upstream
          // state the winner is now using.
          if (started.created) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({
                sessionID: started.openCodeSession.id,
              }),
            ).pipe(Effect.ignore);
          }
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          childTaskBySessionId: new Map(),
          childSessionIdByTaskId: new Map(),
          knownChildSessionIds: new Set(),
          bufferedChildEvents: new Map(),
          seenOpenCodeEventIds: new Set(),
          turns: [],
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };

        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        // The parent OpenCode session is durable but T3's child-session
        // correlation maps and pending-request maps are in-memory. Rebuild
        // them before resuming work so a desktop/server restart cannot leave
        // live children behind stale approval cards or miss their first events.
        if (!started.created) {
          yield* runOpenCodeSdk("session.messages.child-recovery", () =>
            started.client.session.messages({
              sessionID: started.openCodeSession.id,
              directory,
            }),
          ).pipe(
            Effect.flatMap((response) =>
              Effect.forEach(
                response.data ?? [],
                (message) =>
                  Effect.forEach(
                    message.parts,
                    (part) =>
                      part.type === "tool"
                        ? registerChildTaskBinding(context, part, undefined)
                        : Effect.void,
                    { discard: true },
                  ),
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode child-session recovery skipped", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );

          yield* runOpenCodeSdk("permission.list.recovery", () =>
            started.client.permission.list({ directory }),
          ).pipe(
            Effect.flatMap((response) =>
              Effect.forEach(
                response.data ?? [],
                (request) => {
                  context.pendingPermissions.set(request.id, request);
                  const binding = context.childTaskBySessionId.get(request.sessionID);
                  const detail =
                    request.patterns.length > 0 ? request.patterns.join("\n") : request.permission;
                  return Effect.gen(function* () {
                    if (binding) {
                      yield* emitChildTaskProgress(context, binding, {
                        summary: "Waiting for permission",
                        status: "waiting",
                      });
                    }
                    yield* emit({
                      ...(yield* buildEventBase({
                        threadId: context.session.threadId,
                        turnId: binding?.turnId,
                        requestId: request.id,
                      })),
                      type: "request.opened",
                      payload: {
                        requestType: mapPermissionToRequestType(request.permission),
                        detail: binding ? `${binding.title}: ${detail}` : detail,
                        args: request.metadata,
                      },
                    });
                  });
                },
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode pending-permission recovery skipped", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );

          const hasPendingPermission = (childSessionId: string) =>
            [...context.pendingPermissions.values()].some(
              (request) => request.sessionID === childSessionId,
            );
          const resumeRecoveredChild = (binding: OpenCodeChildTaskBinding) =>
            runOpenCodeSdk("session.promptAsync.child-recovery", () =>
              started.client.session.promptAsync({
                sessionID: binding.childSessionId,
                directory,
                parts: [
                  {
                    type: "text" as const,
                    text: "T3 Studio restarted while you were working. Resume from the persisted conversation and current workspace. Continue only the remaining work, verify it, and report the result without repeating completed work. If a previous permission request disappeared during the restart, avoid that blocked external path unless it is still necessary; request permission again if you truly need it.",
                  },
                ],
              }),
            ).pipe(
              Effect.andThen(
                emitChildTaskProgress(context, binding, {
                  summary: "Recovered after T3 Studio restart",
                  status: "running",
                }),
              ),
            );

          // Task-tool children are reconstructed from persisted parent parts.
          // Resume only unfinished children that are not still waiting on a
          // genuine OpenCode permission; completed/error task parts stay put.
          yield* Effect.forEach(
            [...context.childTaskBySessionId.values()].filter(
              (binding) =>
                !binding.direct &&
                !binding.parentTerminal &&
                !binding.childTerminal &&
                !hasPendingPermission(binding.childSessionId),
            ),
            resumeRecoveredChild,
            { discard: true },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode task child recovery skipped", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );

          // Direct/manual Swarm launches do not have a parent task-tool part.
          // Recover them from OpenCode's durable child inventory and only
          // nudge sessions that are not represented by a task binding.
          yield* runOpenCodeSdk("session.children.swarm-recovery", () =>
            started.client.session.children({
              sessionID: started.openCodeSession.id,
              directory,
            }),
          ).pipe(
            Effect.flatMap((response) =>
              Effect.forEach(
                response.data ?? [],
                (child) => {
                  if (context.knownChildSessionIds.has(child.id)) return Effect.void;
                  const binding: OpenCodeChildTaskBinding = {
                    taskId: `opencode-swarm-${child.id}`,
                    childSessionId: child.id,
                    title: child.title || "Recovered swarm agent",
                    description: child.title || "Recovered swarm agent",
                    turnId: undefined,
                    background: true,
                    direct: true,
                    workspaceStrategy: "shared",
                    workspacePath: child.directory,
                    model: null,
                    latestResult: null,
                    parentTerminal: true,
                    childTerminal: false,
                  };
                  context.knownChildSessionIds.add(binding.childSessionId);
                  context.childTaskBySessionId.set(binding.childSessionId, binding);
                  context.childSessionIdByTaskId.set(binding.taskId, binding.childSessionId);
                  return hasPendingPermission(binding.childSessionId)
                    ? emitChildTaskProgress(context, binding, {
                        summary: "Waiting for permission",
                        status: "waiting",
                      })
                    : resumeRecoveredChild(binding);
                },
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("OpenCode direct swarm recovery skipped", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      // A sendTurn while a turn is active is a steer: OpenCode queues the
      // prompt into the busy session and the work continues as one turn, so
      // the active turn id is reused instead of opening a new turn.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const agentTeamSettings = options?.getAgentTeamSettings
        ? yield* options.getAgentTeamSettings()
        : {
            mode: "off" as const,
            maxConcurrency: DEFAULT_AGENT_TEAM_MAX_CONCURRENCY,
          };
      const agentTeamInstruction = buildOpenCodeAgentTeamInstruction(agentTeamSettings);
      const providerText = agentTeamInstruction
        ? [agentTeamInstruction, text ? `User request:\n${text}` : undefined]
            .filter((part): part is string => part !== undefined)
            .join("\n\n")
        : text;
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!providerText || providerText.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.activeTurnId = turnId;
      context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
      context.activeVariant = variant;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
      }

      yield* runOpenCodeSdk("session.promptAsync", () =>
        context.client.session.promptAsync({
          sessionID: context.openCodeSessionId,
          model: parsedModel,
          ...(context.activeAgent ? { agent: context.activeAgent } : {}),
          ...(context.activeVariant ? { variant: context.activeVariant } : {}),
          parts: [
            ...(providerText ? [{ type: "text" as const, text: providerText }] : []),
            ...fileParts,
          ],
        }),
      ).pipe(
        Effect.mapError(toRequestError),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // let the typed error propagate. We don't need to rebuild the error
        // here — `toRequestError` already produced the right shape. A failed
        // steer leaves the still-running original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                context.activeAgent = undefined;
                context.activeVariant = undefined;
                yield* updateProviderSession(
                  context,
                  {
                    status: "ready",
                    model: modelSelection?.model ?? context.session.model,
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestError.detail,
                  },
                });
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        // Re-surface the durable cursor on every turn so the persisted binding
        // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    });

    const findSwarmBinding = (
      context: OpenCodeSessionContext,
      agentId: string,
    ): OpenCodeChildTaskBinding | undefined => {
      const childSessionId = context.childSessionIdByTaskId.get(agentId);
      if (childSessionId) return context.childTaskBySessionId.get(childSessionId);
      return [...context.childTaskBySessionId.values()].find(
        (binding) => binding.taskId === agentId,
      );
    };

    const launchSwarmAgentUnlocked: NonNullable<OpenCodeAdapterShape["launchSwarmAgent"]> =
      Effect.fn("launchSwarmAgentUnlocked")(function* (
        input: ProviderSwarmLaunchAgentResolvedInput,
      ) {
        const context = yield* ensureSessionContext(sessions, input.threadId);
        const agentTeamSettings = options?.getAgentTeamSettings
          ? yield* options.getAgentTeamSettings()
          : {
              mode: "auto" as const,
              maxConcurrency: DEFAULT_AGENT_TEAM_MAX_CONCURRENCY,
            };
        const maxConcurrency = Math.max(
          MIN_AGENT_TEAM_MAX_CONCURRENCY,
          Math.min(MAX_AGENT_TEAM_MAX_CONCURRENCY, Math.trunc(agentTeamSettings.maxConcurrency)),
        );
        const liveCount = [...context.childTaskBySessionId.values()].filter(
          (binding) => !binding.childTerminal,
        ).length;
        if (liveCount >= maxConcurrency) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "launchSwarmAgent",
            issue: `The swarm already has ${liveCount} live agents; the configured limit is ${maxConcurrency}.`,
          });
        }

        const requestedTitle = input.title?.trim();
        const title =
          requestedTitle ?? input.task.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) ?? "Swarm agent";
        const directory = input.directory ?? context.directory;
        const childSession = yield* runOpenCodeSdk("session.create.swarm-child", () =>
          context.client.session.create({
            parentID: context.openCodeSessionId,
            directory,
            title,
          }),
        ).pipe(Effect.mapError(toRequestError));
        if (!childSession.data?.id) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.create.swarm-child",
            detail: "OpenCode returned no child session id.",
          });
        }

        // A deterministic id lets a fresh adapter reconstruct the same routing
        // key from OpenCode's durable parent/child session inventory.
        const taskId = `opencode-swarm-${childSession.data.id}`;
        const binding: OpenCodeChildTaskBinding = {
          taskId,
          childSessionId: childSession.data.id,
          title,
          description: input.task,
          turnId: undefined,
          background: true,
          direct: true,
          workspaceStrategy: input.workspaceStrategy,
          workspacePath: input.directory,
          model: input.modelSelection?.model ?? null,
          latestResult: null,
          parentTerminal: true,
          childTerminal: false,
        };
        context.knownChildSessionIds.add(binding.childSessionId);
        context.childTaskBySessionId.set(binding.childSessionId, binding);
        context.childSessionIdByTaskId.set(binding.taskId, binding.childSessionId);

        yield* emitChildTaskProgress(context, binding, {
          summary:
            input.workspaceStrategy === "worktree" && input.directory
              ? `Started in isolated worktree ${input.directory}`
              : "Started by swarm operator",
          status: "running",
        });

        const parsedModel = input.modelSelection
          ? parseOpenCodeModelSlug(input.modelSelection.model)
          : undefined;
        if (input.modelSelection && !parsedModel) {
          yield* settleChildTask(context, binding, {
            status: "failed",
            summary: "OpenCode model selection must use the 'provider/model' format.",
          });
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "launchSwarmAgent",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }

        yield* runOpenCodeSdk("session.promptAsync.swarm-child", () =>
          context.client.session.promptAsync({
            sessionID: binding.childSessionId,
            ...(parsedModel ? { model: parsedModel } : {}),
            parts: [{ type: "text" as const, text: input.task }],
          }),
        ).pipe(
          Effect.mapError(toRequestError),
          Effect.tapError((error) =>
            settleChildTask(context, binding, {
              status: "failed",
              summary: error.detail,
            }),
          ),
        );

        return {
          agentId: binding.taskId,
          sessionId: binding.childSessionId,
          title: binding.title,
          workspaceStrategy: binding.workspaceStrategy,
          ...(binding.workspacePath ? { workspacePath: binding.workspacePath } : {}),
        } satisfies ProviderSwarmLaunchAgentResult;
      });
    const launchSwarmAgent: NonNullable<OpenCodeAdapterShape["launchSwarmAgent"]> = (input) =>
      swarmLaunchMutex.withPermits(1)(launchSwarmAgentUnlocked(input));

    const messageSwarmAgent: NonNullable<OpenCodeAdapterShape["messageSwarmAgent"]> = Effect.fn(
      "messageSwarmAgent",
    )(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      const binding = findSwarmBinding(context, input.agentId);
      if (!binding || binding.childTerminal) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "messageSwarmAgent",
          issue: `No live swarm agent '${input.agentId}' exists in this thread.`,
        });
      }
      yield* runOpenCodeSdk("session.promptAsync.swarm-message", () =>
        context.client.session.promptAsync({
          sessionID: binding.childSessionId,
          parts: [{ type: "text" as const, text: input.message }],
        }),
      ).pipe(Effect.mapError(toRequestError));
      yield* emitChildTaskProgress(context, binding, {
        summary: "Operator instruction sent",
        status: "running",
      });
    });

    const stopSwarmAgent: NonNullable<OpenCodeAdapterShape["stopSwarmAgent"]> = Effect.fn(
      "stopSwarmAgent",
    )(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      const binding = findSwarmBinding(context, input.agentId);
      if (!binding || binding.childTerminal) return;
      yield* runOpenCodeSdk("session.abort.swarm-child", () =>
        context.client.session.abort({ sessionID: binding.childSessionId }),
      ).pipe(Effect.mapError(toRequestError));
      yield* settleChildTask(context, binding, {
        status: "stopped",
        summary: "Stopped by swarm operator",
      });
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const interruptedTurnId = turnId ?? context.activeTurnId;
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const liveChildren = [...context.childTaskBySessionId.values()].filter(
          (binding) =>
            !binding.childTerminal &&
            (interruptedTurnId === undefined || binding.turnId === interruptedTurnId),
        );
        yield* Effect.forEach(
          liveChildren,
          (binding) =>
            runOpenCodeSdk("session.abort.child", () =>
              context.client.session.abort({ sessionID: binding.childSessionId }),
            ).pipe(
              Effect.ignore({ log: true }),
              Effect.andThen(
                settleChildTask(context, binding, {
                  status: "stopped",
                  summary: "Interrupted with the parent turn",
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
        if (interruptedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: interruptedTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      launchSwarmAgent,
      messageSwarmAgent,
      stopSwarmAgent,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
