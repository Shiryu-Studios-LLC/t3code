import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeTaskId,
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

interface DirectSwarmAgentState {
  readonly agentId: string;
  readonly title: string;
  readonly task: string;
  readonly model: string;
  readonly workspaceStrategy: "shared" | "worktree";
  readonly workspacePath?: string;
  history: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
  pendingMessages: Array<string>;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  running: boolean;
  stopRequested: boolean;
  latestResult?: string;
}

interface SessionState {
  session: ProviderSession;
  turns: Array<ProviderThreadTurnSnapshot>;
  history: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
  activeFiber?: Fiber.Fiber<string, ProviderAdapterError>;
  swarmAgents: Map<string, DirectSwarmAgentState>;
}

export interface DirectChatAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId?: ProviderInstanceId;
  readonly defaultModel: string;
  readonly runChat: (input: {
    readonly threadId: ThreadId;
    readonly model: string;
    readonly cwd?: string;
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

  const publishSwarmProgress = Effect.fn("DirectChatAdapter.publishSwarmProgress")(function* (
    threadId: ThreadId,
    agent: DirectSwarmAgentState,
    summary: string,
    status: "pending" | "running" | "waiting" | "idle" = "running",
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* publish({
      eventId: EventId.make(yield* nextId("event")),
      provider: options.provider,
      ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
      threadId,
      createdAt,
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make(agent.agentId),
        taskType: "shiryugen_swarm_agent",
        description: agent.task,
        title: agent.title,
        role: "ShiryuGen swarm agent",
        model: agent.model,
        status,
        summary,
      },
    });
  });

  const publishSwarmCompleted = Effect.fn("DirectChatAdapter.publishSwarmCompleted")(function* (
    threadId: ThreadId,
    agent: DirectSwarmAgentState,
    status: "completed" | "failed" | "stopped",
    summary: string,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* publish({
      eventId: EventId.make(yield* nextId("event")),
      provider: options.provider,
      ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
      threadId,
      createdAt,
      type: "task.completed",
      payload: {
        taskId: RuntimeTaskId.make(agent.agentId),
        taskType: "shiryugen_swarm_agent",
        title: agent.title,
        role: "ShiryuGen swarm agent",
        model: agent.model,
        status,
        summary,
      },
    });
  });

  const runSwarmAgent = (
    threadId: ThreadId,
    agent: DirectSwarmAgentState,
    initialPrompt: string,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      let prompt: string | undefined = initialPrompt;
      while (prompt && !agent.stopRequested) {
        yield* publishSwarmProgress(threadId, agent, "Working on assigned task", "running");
        const history = [...agent.history, { role: "user" as const, content: prompt }];
        const outcome = yield* options
          .runChat({
            threadId,
            model: agent.model,
            ...(agent.workspacePath ? { cwd: agent.workspacePath } : {}),
            history,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );
        if (!outcome.ok) {
          agent.running = false;
          agent.activeFiber = undefined;
          const detail = outcome.error.message || "Swarm agent failed.";
          yield* publishSwarmCompleted(threadId, agent, "failed", detail);
          return;
        }
        agent.latestResult = outcome.value;
        agent.history = [...history, { role: "assistant", content: outcome.value }];
        prompt = agent.pendingMessages.shift();
      }

      agent.running = false;
      agent.activeFiber = undefined;
      if (agent.stopRequested) return;
      yield* publishSwarmCompleted(
        threadId,
        agent,
        "completed",
        agent.latestResult?.trim() || "Swarm agent completed its task.",
      );
    });

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
          new Map(all).set(input.threadId, {
            session,
            turns: [],
            history: [],
            swarmAgents: new Map(),
          }),
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
          ...(state.session.cwd !== undefined ? { cwd: state.session.cwd } : {}),
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
      Effect.gen(function* () {
        const state = yield* requireSession(threadId);
        for (const agent of state.swarmAgents.values()) {
          agent.stopRequested = true;
          if (agent.activeFiber) yield* Fiber.interrupt(agent.activeFiber).pipe(Effect.asVoid);
        }
        yield* Ref.update(sessions, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return next;
        });
      }),
    launchSwarmAgent: (input) =>
      Effect.gen(function* () {
        const state = yield* requireSession(input.threadId);
        const liveCount = [...state.swarmAgents.values()].filter((agent) => agent.running).length;
        if (liveCount >= 15) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "launchSwarmAgent",
            issue: `The swarm already has ${liveCount} live agents; the direct-provider limit is 15.`,
          });
        }
        const agentId = `shiryugen-swarm-${yield* nextId("agent")}`;
        const title =
          input.title?.trim() ||
          input.task.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) ||
          "Swarm agent";
        const agent: DirectSwarmAgentState = {
          agentId,
          title,
          task: input.task,
          model: input.modelSelection?.model ?? state.session.model ?? options.defaultModel,
          workspaceStrategy: input.workspaceStrategy,
          ...(input.directory
            ? { workspacePath: input.directory }
            : state.session.cwd
              ? { workspacePath: state.session.cwd }
              : {}),
          history: [],
          pendingMessages: [],
          activeFiber: undefined,
          running: true,
          stopRequested: false,
        };
        state.swarmAgents.set(agentId, agent);
        yield* publishSwarmProgress(
          input.threadId,
          agent,
          input.workspaceStrategy === "worktree" && input.directory
            ? `Started in isolated worktree ${input.directory}`
            : "Started by ShiryuGen swarm",
          "running",
        );
        const fiber = yield* Effect.forkDetach(runSwarmAgent(input.threadId, agent, input.task));
        agent.activeFiber = fiber;
        return {
          agentId,
          sessionId: agentId,
          title,
          workspaceStrategy: input.workspaceStrategy,
          ...(agent.workspacePath ? { workspacePath: agent.workspacePath } : {}),
        };
      }),
    messageSwarmAgent: (input) =>
      Effect.gen(function* () {
        const state = yield* requireSession(input.threadId);
        const agent = state.swarmAgents.get(input.agentId);
        if (!agent || !agent.running || agent.stopRequested) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "messageSwarmAgent",
            issue: `No live swarm agent '${input.agentId}' exists in this thread.`,
          });
        }
        agent.pendingMessages.push(input.message);
        yield* publishSwarmProgress(
          input.threadId,
          agent,
          "Operator instruction queued",
          "running",
        );
      }),
    stopSwarmAgent: (input) =>
      Effect.gen(function* () {
        const state = yield* requireSession(input.threadId);
        const agent = state.swarmAgents.get(input.agentId);
        if (!agent || !agent.running) return;
        agent.stopRequested = true;
        agent.running = false;
        if (agent.activeFiber) yield* Fiber.interrupt(agent.activeFiber).pipe(Effect.asVoid);
        agent.activeFiber = undefined;
        yield* publishSwarmCompleted(input.threadId, agent, "stopped", "Stopped by swarm operator");
      }),
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
    stopAll: () =>
      Effect.gen(function* () {
        const all = yield* Ref.get(sessions);
        for (const state of all.values()) {
          for (const agent of state.swarmAgents.values()) {
            agent.stopRequested = true;
            if (agent.activeFiber) yield* Fiber.interrupt(agent.activeFiber).pipe(Effect.asVoid);
          }
        }
        yield* Ref.set(sessions, new Map());
      }),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
