import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  buildOpenCodeAgentTeamInstruction,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  openCodeTaskChildSessionId,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    sessionGetIds: [] as string[],
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.sessionGetIds.length = 0;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          // The real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing → 404 throw, transient → 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          return { data: { id: sessionID, ...(directory ? { directory } : {}) } };
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });
          return { data: { id: sessionID } };
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
          // Fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });
          if (directory) {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
          })(),
        }),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

it("extracts OpenCode child-session identity from task metadata", () => {
  const part = {
    id: "part-task",
    sessionID: "parent",
    messageID: "assistant",
    type: "tool" as const,
    callID: "call-task",
    tool: "task",
    state: {
      status: "running" as const,
      input: { prompt: "Do work" },
      title: "Worker",
      metadata: { sessionId: "child-123" },
      time: { start: 1 },
    },
  };
  NodeAssert.equal(openCodeTaskChildSessionId(part), "child-123");
  NodeAssert.equal(
    openCodeTaskChildSessionId({
      ...part,
      state: { ...part.state, metadata: { child_session_id: "child-legacy" } },
    }),
    "child-legacy",
  );
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("returns a durable resume cursor for a freshly created session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      // Without a persisted cursor, a session is created and its id is
      // surfaced as a resume cursor so the upper layer can persist it.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the persisted OpenCode session instead of creating a new one", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      // The adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_persisted"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });
      // Resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_persisted");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends follow-up turns to the resumed session id", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-turn");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "continue where we left off",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      // The prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        "ses_persisted",
      );
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rebuilds child-session correlation when resuming a persisted parent session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-child-correlation");
      const parentSessionID = "persisted-parent-session";
      const childSessionID = "persisted-child-session";
      runtimeMock.state.messages = [
        {
          info: { id: "persisted-assistant", role: "assistant" },
          parts: [
            {
              id: "persisted-task-part",
              sessionID: parentSessionID,
              messageID: "persisted-assistant",
              type: "tool",
              callID: "persisted-child-call",
              tool: "task",
              state: {
                status: "running",
                title: "Persisted worker",
                input: { prompt: "Continue persisted work" },
                metadata: { sessionId: childSessionID, parentSessionId: parentSessionID },
                time: { start: 1 },
              },
            },
          ],
        },
      ];
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-persisted-child-busy",
          type: "session.status",
          properties: { sessionID: childSessionID, status: { type: "busy" } },
        },
      ];

      const progressFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.progress"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: parentSessionID },
      });

      const events = Array.from(yield* Fiber.join(progressFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.length, 1);
      const progress = events[0];
      NodeAssert.equal(progress?.type, "task.progress");
      if (progress?.type === "task.progress") {
        NodeAssert.equal(progress.payload.taskId, "persisted-child-call");
        NodeAssert.equal(progress.payload.runHandles?.runId, childSessionID);
      }
    }),
  );

  it.effect("falls back to a fresh session when the persisted session is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale");
      runtimeMock.state.missingSessionIds.add("ses_stale");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_stale" },
      });

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_stale"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a malformed or wrong-version resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-badcursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "ses_persisted" },
      });

      // A foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a non-not-found resume probe error instead of silently starting fresh", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-transient");
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add("ses_transient");

      const exit = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_transient" },
        }),
      );

      // A transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_transient"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
    }),
  );

  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("reuses the resumed session when the stored directory differs only lexically", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-samedir");
      // Same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set("ses_samedir", `${process.cwd()}/`);

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_samedir" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_samedir"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_samedir",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails sendTurn for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-opencode-missing-send"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-send");
    }),
  );

  it.effect("fails stopSession for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .stopSession(asThreadId("thread-opencode-missing-stop"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-stop");
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("stopping a parent session also aborts a still-running background child", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-with-child");
      const parentSessionID = "http://127.0.0.1:9999/session";
      const childSessionID = "child-stop-session";
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-stop-child-task",
          type: "message.part.updated",
          properties: {
            sessionID: parentSessionID,
            part: {
              id: "part-stop-child",
              sessionID: parentSessionID,
              messageID: "message-stop-child",
              type: "tool",
              callID: "call-stop-child",
              tool: "task",
              state: {
                status: "running",
                title: "Long worker",
                input: { prompt: "Keep working" },
                metadata: {
                  sessionId: childSessionID,
                  parentSessionId: parentSessionID,
                  background: true,
                },
                time: { start: 1 },
              },
            },
            time: 1,
          },
        },
      ];

      const itemFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "item.updated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* Fiber.join(itemFiber).pipe(Effect.timeout("1 second"));
      yield* adapter.stopSession(threadId);

      NodeAssert.ok(runtimeMock.state.abortCalls.includes(childSessionID));
      NodeAssert.ok(runtimeMock.state.abortCalls.includes(parentSessionID));
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      // At least both live contexts must attempt cleanup. Layer/test-scope
      // finalization may race in and repeat an idempotent external-server
      // close probe, so an exact global count is not a stable invariant.
      NodeAssert.ok(runtimeMock.state.closeCalls.length >= 2);
      NodeAssert.ok(runtimeMock.state.closeCalls.every((url) => url === "http://127.0.0.1:9999"));
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect(
    "injects the OpenCode team orchestration contract without changing the visible user message",
    () => {
      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          getAgentTeamSettings: () => Effect.succeed({ mode: "auto", maxConcurrency: 3 }),
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-agent-team-auto");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "Implement the API and UI, then test both.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });

        const call = runtimeMock.state.promptCalls.at(-1) as {
          readonly parts?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
        };
        const promptText = call.parts?.find((part) => part.type === "text")?.text ?? "";
        NodeAssert.match(promptText, /\[T3 Agent Team Mode\]/);
        NodeAssert.match(promptText, /more than 3 child agents running concurrently/);
        NodeAssert.match(promptText, /User request:\nImplement the API and UI, then test both\./);
      }).pipe(Effect.provide(adapterLayer));
    },
  );

  it.effect("builds bounded auto and always team instructions and leaves off mode untouched", () =>
    Effect.sync(() => {
      NodeAssert.equal(
        buildOpenCodeAgentTeamInstruction({ mode: "off", maxConcurrency: 4 }),
        undefined,
      );
      const auto = buildOpenCodeAgentTeamInstruction({ mode: "auto", maxConcurrency: 99 });
      NodeAssert.ok(auto);
      NodeAssert.match(auto, /more than 15 child agents running concurrently/);
      NodeAssert.match(
        auto,
        /decide whether the request has at least two useful independent workstreams/,
      );
      NodeAssert.match(auto, /\[T3 Swarm Control\]/);
      NodeAssert.match(auto, /isolated Git worktree/);

      const always = buildOpenCodeAgentTeamInstruction({ mode: "always", maxConcurrency: 2 });
      NodeAssert.ok(always);
      NodeAssert.match(always, /delegate at least two independent subtasks/);
    }),
  );

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("classifies a confirmed not-found across the shapes the SDK/runtime can produce", () =>
    Effect.sync(() => {
      // The real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error("Session not found: ses_x", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      });
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: "OpenCodeRuntimeError",
          operation: "session.get",
          detail: "Session not found: ses_x",
          cause: wrappedError,
        }),
        true,
      );

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true);
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error("x", { cause: { status: 404 } })), true);
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true);
      // OpenCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: "NotFoundError" } }), true);

      // NOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error("upstream provider not found", { cause: { status: 500 } })),
        false,
      );
      NodeAssert.equal(isOpenCodeNotFound({ detail: "status=500 body={...not found...}" }), false);
      // An explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // *NotFound* — is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } }), false);
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError", status: 500 }), false);
      // A "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError" }), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: "ProviderNotFoundError" } }), false);
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error("x", { cause: { status: 502, body: { name: "NotFoundError" } } }),
        ),
        false,
      );
      // Other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error("boom", { cause: { status: 500 } })), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false);
      NodeAssert.equal(isOpenCodeNotFound(new Error("network error (no response)")), false);
      NodeAssert.equal(isOpenCodeNotFound(undefined), false);
    }),
  );

  it.effect("treats lexically or physically identical directories as the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right);

      // Lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory("/repo/project/", "/repo/project"), true);
      NodeAssert.equal(yield* sameDirectory("/repo/nested/../project", "/repo/project"), true);
      // Nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory("/repo/project", "/repo/other"), false);

      // A symlinked cwd (the macOS `/tmp` → `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-dir-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      const symlinkExit = yield* Effect.exit(fileSystem.symlink(real, link));
      // Windows requires Developer Mode/admin privileges for directory
      // symlinks. The lexical/fallback assertions above still exercise the
      // production behavior there; only run the physical-identity portion
      // when the host permits creating the fixture.
      if (Exit.isFailure(symlinkExit)) return;
      NodeAssert.equal(yield* sameDirectory(link, real), true);
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, "other")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect(
    "streams multiple native OpenCode child-agent tasks and the consolidated parent result",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-agent-team-events");
        const sessionID = "http://127.0.0.1:9999/session";
        const assistantMessageID = "msg-agent-team-parent";
        runtimeMock.state.subscribedEvents = [
          {
            type: "message.updated",
            properties: {
              sessionID,
              info: { id: assistantMessageID, role: "assistant" },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-child-alpha",
                sessionID,
                messageID: assistantMessageID,
                type: "tool",
                callID: "call-child-alpha",
                tool: "task",
                state: {
                  status: "running",
                  title: "Analyze alpha",
                  input: { subagent_type: "explore", prompt: "Read alpha.txt" },
                  time: { start: 1 },
                },
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-child-beta",
                sessionID,
                messageID: assistantMessageID,
                type: "tool",
                callID: "call-child-beta",
                tool: "task",
                state: {
                  status: "running",
                  title: "Analyze beta",
                  input: { subagent_type: "explore", prompt: "Read beta.txt" },
                  time: { start: 2 },
                },
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-child-alpha",
                sessionID,
                messageID: assistantMessageID,
                type: "tool",
                callID: "call-child-alpha",
                tool: "task",
                state: {
                  status: "completed",
                  input: { subagent_type: "explore", prompt: "Read alpha.txt" },
                  output: "Northern gate: sunrise, violet.",
                  title: "Analyze alpha",
                  time: { start: 1, end: 3 },
                },
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-child-beta",
                sessionID,
                messageID: assistantMessageID,
                type: "tool",
                callID: "call-child-beta",
                tool: "task",
                state: {
                  status: "completed",
                  input: { subagent_type: "explore", prompt: "Read beta.txt" },
                  output: "Southern gate: sunset, amber.",
                  title: "Analyze beta",
                  time: { start: 2, end: 4 },
                },
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-parent-final",
                sessionID,
                messageID: assistantMessageID,
                type: "text",
                text: "Northern gate: sunrise/violet. Southern gate: sunset/amber.",
                time: { start: 5, end: 6 },
              },
            },
          },
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.take(8),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
        const childEvents = events.filter(
          (event) =>
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed") &&
            event.payload.itemType === "collab_agent_tool_call",
        );
        NodeAssert.equal(childEvents.length, 4);
        NodeAssert.deepEqual(
          childEvents.map((event) => event.itemId),
          ["call-child-alpha", "call-child-beta", "call-child-alpha", "call-child-beta"],
        );
        const finalDelta = events.find(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        );
        NodeAssert.ok(finalDelta);
        if (finalDelta.type === "content.delta") {
          NodeAssert.equal(
            finalDelta.payload.delta,
            "Northern gate: sunrise/violet. Southern gate: sunset/amber.",
          );
        }
      }),
  );

  it.effect(
    "correlates five child sessions, preserves child heartbeats, dedupes replay, and recombines only parent text",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-five-child-correlation");
        const parentSessionID = "http://127.0.0.1:9999/session";
        const assistantMessageID = "msg-five-child-parent";
        const workers = Array.from({ length: 5 }, (_, index) => ({
          index,
          callID: `call-worker-${index}`,
          childSessionID: `child-session-${index}`,
          title: `Worker ${index + 1}`,
        }));

        const parentRunningParts = workers.map((worker) => ({
          id: `evt-parent-task-running-${worker.index}`,
          type: "message.part.updated",
          properties: {
            sessionID: parentSessionID,
            part: {
              id: `part-worker-${worker.index}`,
              sessionID: parentSessionID,
              messageID: assistantMessageID,
              type: "tool",
              callID: worker.callID,
              tool: "task",
              state: {
                status: "running",
                title: worker.title,
                input: { prompt: `Implement workstream ${worker.index + 1}` },
                metadata: {
                  parentSessionId: parentSessionID,
                  sessionId: worker.childSessionID,
                  model: { providerID: "opencode", modelID: "test-model" },
                },
                time: { start: 10 + worker.index },
              },
            },
            time: 10 + worker.index,
          },
        }));
        const parentCompletedParts = workers.map((worker) => ({
          id: `evt-parent-task-completed-${worker.index}`,
          type: "message.part.updated",
          properties: {
            sessionID: parentSessionID,
            part: {
              id: `part-worker-${worker.index}`,
              sessionID: parentSessionID,
              messageID: assistantMessageID,
              type: "tool",
              callID: worker.callID,
              tool: "task",
              state: {
                status: "completed",
                title: worker.title,
                input: { prompt: `Implement workstream ${worker.index + 1}` },
                output: `Worker ${worker.index + 1} finished.`,
                metadata: {
                  parentSessionId: parentSessionID,
                  sessionId: worker.childSessionID,
                },
                time: { start: 10 + worker.index, end: 80 + worker.index },
              },
            },
            time: 80 + worker.index,
          },
        }));
        const childCreated = workers.map((worker) => ({
          id: `evt-child-created-${worker.index}`,
          type: "session.created",
          properties: {
            sessionID: worker.childSessionID,
            info: {
              id: worker.childSessionID,
              slug: worker.childSessionID,
              projectID: "project",
              directory: "I:/repo",
              parentID: parentSessionID,
              title: `${worker.title} subagent`,
              model: { id: "test-model", providerID: "opencode" },
              version: "1",
              time: { created: 1, updated: 1 },
            },
          },
        }));
        const childToolEvents = workers.map((worker) => ({
          id: `evt-child-tool-${worker.index}`,
          type: "message.part.updated",
          properties: {
            sessionID: worker.childSessionID,
            part: {
              id: `child-tool-part-${worker.index}`,
              sessionID: worker.childSessionID,
              messageID: `child-message-${worker.index}`,
              type: "tool",
              callID: `child-tool-call-${worker.index}`,
              tool: "read",
              state: {
                status: "running",
                input: { path: `file-${worker.index}.ts` },
                title: "Read file",
                time: { start: 30 + worker.index },
              },
            },
            time: 30 + worker.index,
          },
        }));
        const childBusy = workers.map((worker) => ({
          id: `evt-child-busy-${worker.index}`,
          type: "session.status",
          properties: { sessionID: worker.childSessionID, status: { type: "busy" } },
        }));
        const childIdle = workers.map((worker) => ({
          id: `evt-child-idle-${worker.index}`,
          type: "session.status",
          properties: { sessionID: worker.childSessionID, status: { type: "idle" } },
        }));

        runtimeMock.state.subscribedEvents = [
          {
            id: "evt-parent-message",
            type: "message.updated",
            properties: {
              sessionID: parentSessionID,
              info: { id: assistantMessageID, role: "assistant" },
            },
          },
          // Worker 1 proves the difficult ordering: OpenCode creates and even
          // starts the child before the parent task wrapper carries sessionId.
          childCreated[0],
          {
            id: "evt-child-early-reasoning",
            type: "session.next.reasoning.started",
            properties: {
              timestamp: 5,
              sessionID: workers[0]!.childSessionID,
              reasoningID: "reasoning-early",
            },
          },
          ...parentRunningParts,
          ...childCreated.slice(1),
          ...childToolEvents,
          ...childBusy,
          // Replay of a provider event must not advance the agent twice.
          childBusy[2],
          ...childIdle,
          ...parentCompletedParts,
          {
            id: "evt-parent-final-text",
            type: "message.part.updated",
            properties: {
              sessionID: parentSessionID,
              part: {
                id: "part-parent-consolidated",
                sessionID: parentSessionID,
                messageID: assistantMessageID,
                type: "text",
                text: "All five workstreams were integrated and verified.",
                time: { start: 100, end: 101 },
              },
              time: 101,
            },
          },
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.take(40),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        const taskProgress = events.filter((event) => event.type === "task.progress");
        const childTaskIds = new Set(
          taskProgress.map((event) => (event.type === "task.progress" ? event.payload.taskId : "")),
        );
        NodeAssert.deepEqual(
          [...childTaskIds].sort(),
          workers.map((worker) => worker.callID).sort(),
        );
        const toolProgress = events.filter((event) => event.type === "tool.progress");
        NodeAssert.equal(toolProgress.length, 5);
        NodeAssert.deepEqual(
          toolProgress.map((event) =>
            event.type === "tool.progress" ? event.payload.taskId : undefined,
          ),
          workers.map((worker) => worker.callID),
        );
        const childCompletions = events.filter(
          (event) => event.type === "task.updated" && event.payload.status === "completed",
        );
        NodeAssert.equal(childCompletions.length, 5);
        const parentText = events.filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        );
        NodeAssert.equal(parentText.length, 1);
        if (parentText[0]?.type === "content.delta") {
          NodeAssert.equal(
            parentText[0].payload.delta,
            "All five workstreams were integrated and verified.",
          );
        }
      }),
  );

  it.effect("surfaces child questions and permission requests on the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-input");
      const parentSessionID = "http://127.0.0.1:9999/session";
      const childSessionID = "child-input-session";
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-input-parent-task",
          type: "message.part.updated",
          properties: {
            sessionID: parentSessionID,
            part: {
              id: "part-input-worker",
              sessionID: parentSessionID,
              messageID: "parent-message-input",
              type: "tool",
              callID: "call-input-worker",
              tool: "task",
              state: {
                status: "running",
                title: "Input worker",
                input: { prompt: "Validate guarded behavior" },
                metadata: { sessionId: childSessionID, parentSessionId: parentSessionID },
                time: { start: 1 },
              },
            },
            time: 1,
          },
        },
        {
          id: "evt-input-child-created",
          type: "session.created",
          properties: {
            sessionID: childSessionID,
            info: {
              id: childSessionID,
              slug: childSessionID,
              projectID: "project",
              directory: "I:/repo",
              parentID: parentSessionID,
              title: "Input worker",
              version: "1",
              time: { created: 1, updated: 1 },
            },
          },
        },
        {
          id: "evt-child-question",
          type: "question.asked",
          properties: {
            id: "question-child",
            sessionID: childSessionID,
            questions: [
              {
                header: "Mode",
                question: "Which validation mode?",
                options: [{ label: "Safe", description: "Use safe mode" }],
              },
            ],
          },
        },
        {
          id: "evt-child-permission",
          type: "permission.asked",
          properties: {
            id: "permission-child",
            sessionID: childSessionID,
            permission: "bash",
            patterns: ["pytest tests/"],
            metadata: {},
            always: [],
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "user-input.requested" || event.type === "request.opened",
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events[0]?.type, "user-input.requested");
      NodeAssert.equal(events[1]?.type, "request.opened");
      if (events[0]?.type === "user-input.requested") {
        NodeAssert.match(events[0].payload.questions[0]?.header ?? "", /^Input worker:/);
      }
      if (events[1]?.type === "request.opened") {
        NodeAssert.match(events[1].payload.detail ?? "", /^Input worker:/);
      }
    }),
  );

  it.effect("maps a child rate limit to the worker without failing its sibling", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-rate-limit");
      const parentSessionID = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        ...[0, 1].map((index) => ({
          id: `evt-rate-parent-${index}`,
          type: "message.part.updated",
          properties: {
            sessionID: parentSessionID,
            part: {
              id: `part-rate-${index}`,
              sessionID: parentSessionID,
              messageID: "msg-rate-parent",
              type: "tool",
              callID: `call-rate-${index}`,
              tool: "task",
              state: {
                status: "running",
                title: `Rate worker ${index + 1}`,
                input: { prompt: `Do rate work ${index + 1}` },
                metadata: { sessionId: `child-rate-${index}`, parentSessionId: parentSessionID },
                time: { start: index + 1 },
              },
            },
            time: index + 1,
          },
        })),
        {
          id: "evt-rate-failed",
          type: "session.error",
          properties: {
            sessionID: "child-rate-0",
            error: {
              name: "APIError",
              data: {
                message: "Too many requests",
                statusCode: 429,
                isRetryable: true,
                responseHeaders: { "retry-after": "12" },
              },
            },
          },
        },
        {
          id: "evt-rate-sibling-busy",
          type: "session.status",
          properties: { sessionID: "child-rate-1", status: { type: "busy" } },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.updated" || event.type === "task.progress"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const failed = events.find(
        (event) => event.type === "task.updated" && event.payload.taskId === "call-rate-0",
      );
      NodeAssert.ok(failed);
      if (failed.type === "task.updated") {
        NodeAssert.equal(failed.payload.status, "failed");
        NodeAssert.match(failed.payload.error ?? "", /HTTP 429/);
        NodeAssert.match(failed.payload.error ?? "", /Retry-After 12/);
      }
      const sibling = events.find(
        (event) => event.type === "task.progress" && event.payload.taskId === "call-rate-1",
      );
      NodeAssert.ok(sibling);
      if (sibling.type === "task.progress") NodeAssert.equal(sibling.payload.status, "running");
    }),
  );

  it.effect("lets OpenCode own session title generation and emits title metadata updates", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-sync");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate OpenCode title sync",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal("title" in (runtimeMock.state.sessionCreateInputs[0] ?? {}), false);

      const metadataUpdated = events.find((event) => event.type === "thread.metadata.updated");
      NodeAssert.ok(metadataUpdated);
      if (metadataUpdated.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated.payload.name, "Investigate OpenCode title sync");
      }
    }),
  );

  it.effect("passes the thread title to session.create when provided", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-provided");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        title: "Investigate reconnect failures",
      });

      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal(
        runtimeMock.state.sessionCreateInputs[0]?.title,
        "Investigate reconnect failures",
      );
    }),
  );

  it.effect("does not mirror OpenCode's default placeholder session titles", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-placeholder-title");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "New session - 2026-08-09T10:20:30.456Z",
            },
          },
        },
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate reconnect failures",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const metadataUpdated = events.filter((event) => event.type === "thread.metadata.updated");
      NodeAssert.equal(metadataUpdated.length, 1);
      if (metadataUpdated[0]?.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated[0].payload.name, "Investigate reconnect failures");
      }
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
