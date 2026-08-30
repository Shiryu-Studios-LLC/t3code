import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

interface SessionState {
  session: ProviderSession;
  turns: Array<ProviderThreadTurnSnapshot>;
  history: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
  activeFiber?: Fiber.Fiber<string, ProviderAdapterError>;
}

export interface DirectChatAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId?: ProviderInstanceId;
  readonly defaultModel: string;
  readonly runChat: (input: {
    readonly threadId: ThreadId;
    readonly model: string;
    readonly history: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly content: string;
    }>;
  }) => Effect.Effect<string, ProviderAdapterError>;
}

export const makeDirectChatAdapter = Effect.fn("makeDirectChatAdapter")(function* (
  options: DirectChatAdapterOptions,
) {
  const sessions = yield* Ref.make(new Map<ThreadId, SessionState>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sequence = yield* Ref.make(0);
  const nextId = (prefix: string) =>
    Ref.modify(sequence, (n) => [`${prefix}_${n + 1}`, n + 1] as const);
  const requireSession = (threadId: ThreadId) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((all) => {
        const state = all.get(threadId);
        return state
          ? Effect.succeed(state)
          : new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId });
      }),
    );
  const publish = (event: ProviderRuntimeEvent) => PubSub.publish(events, event);

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: options.provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const session: ProviderSession = {
          provider: options.provider,
          ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model: input.modelSelection?.model ?? options.defaultModel,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        yield* Ref.update(sessions, (all) =>
          new Map(all).set(input.threadId, { session, turns: [], history: [] }),
        );
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const state = yield* requireSession(input.threadId);
        const prompt = input.input?.trim();
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "sendTurn",
            issue: "A non-empty prompt is required.",
          });
        }
        const turnId = TurnId.make(yield* nextId("turn"));
        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const eventId = EventId.make(yield* nextId("event"));
        const base = {
          eventId,
          provider: options.provider,
          ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
          threadId: input.threadId,
          createdAt: startedAt,
          turnId,
        };
        yield* publish({
          ...base,
          type: "turn.started",
          payload: { model: input.modelSelection?.model ?? state.session.model },
        });
        const history = [...state.history, { role: "user" as const, content: prompt }];
        const response = yield* options.runChat({
          threadId: input.threadId,
          model: input.modelSelection?.model ?? state.session.model ?? options.defaultModel,
          history,
        });
        const deltaId = EventId.make(yield* nextId("event"));
        yield* publish({
          ...base,
          eventId: deltaId,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: response },
        });
        const completedId = EventId.make(yield* nextId("event"));
        yield* publish({
          ...base,
          eventId: completedId,
          type: "turn.completed",
          payload: { state: "completed" },
        });
        state.history = [...history, { role: "assistant", content: response }];
        state.turns = [...state.turns, { id: turnId, items: [{ prompt, response }] }];
        return { threadId: input.threadId, turnId };
      }),
    interruptTurn: (threadId) => requireSession(threadId).pipe(Effect.asVoid),
    respondToRequest: (
      threadId,
      requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(
          () =>
            new ProviderAdapterRequestError({
              provider: options.provider,
              method: "respondToRequest",
              detail: `No pending approval request '${requestId}'.`,
            }),
        ),
      ),
    respondToUserInput: (
      threadId,
      requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(
          () =>
            new ProviderAdapterRequestError({
              provider: options.provider,
              method: "respondToUserInput",
              detail: `No pending user-input request '${requestId}'.`,
            }),
        ),
      ),
    stopSession: (threadId) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Ref.update(sessions, (all) => {
            const next = new Map(all);
            next.delete(threadId);
            return next;
          }),
        ),
      ),
    listSessions: () =>
      Ref.get(sessions).pipe(
        Effect.map((all) => Array.from(all.values(), ({ session }) => session)),
      ),
    hasSession: (threadId) => Ref.get(sessions).pipe(Effect.map((all) => all.has(threadId))),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((state) => ({ threadId, turns: state.turns }))),
    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        const state = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1)
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        state.turns = state.turns.slice(0, Math.max(0, state.turns.length - numTurns));
        state.history = state.history.slice(0, state.turns.length * 2);
        return { threadId, turns: state.turns };
      }),
    stopAll: () => Ref.set(sessions, new Map()),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
