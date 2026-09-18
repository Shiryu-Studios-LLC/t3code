import {
  DEFAULT_SERVER_SETTINGS,
  GeminiSettings,
  NvidiaSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  redactServerSettingsForClient,
  restoreRedactedProviderConfigSecrets,
} from "../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { makeDirectChatAdapter } from "./Layers/DirectChatAdapter.ts";
import {
  checkGeminiProviderStatus,
  fetchGeminiRemoteModels,
  resolveGeminiApiEndpoint,
  resolveGeminiModel,
} from "./Layers/GeminiProvider.ts";
import {
  checkNvidiaProviderStatus,
  fetchNvidiaRemoteModels,
  resolveNvidiaModel,
} from "./Layers/NvidiaProvider.ts";
import { isRetryableNvidiaStatus } from "./Layers/NvidiaAdapter.ts";

const decodeGemini = Schema.decodeSync(GeminiSettings);
const decodeNvidia = Schema.decodeSync(NvidiaSettings);

describe("Gemini and NVIDIA drivers", () => {
  it("registers both drivers in the desktop build", () => {
    const registered = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    expect(registered.has(ProviderDriverKind.make("gemini"))).toBe(true);
    expect(registered.has(ProviderDriverKind.make("nvidia"))).toBe(true);
  });

  it.effect("reports configured API-key providers as ready", () =>
    Effect.gen(function* () {
      const gemini = yield* checkGeminiProviderStatus(decodeGemini({ apiKey: "test-key" }));
      const nvidia = yield* checkNvidiaProviderStatus(
        decodeNvidia({ enabled: true, apiKey: "test-key" }),
      );

      expect(gemini.status).toBe("ready");
      expect(nvidia.status).toBe("ready");
    }),
  );

  it("normalizes root Gemini endpoints and resolves model aliases", () => {
    expect(
      resolveGeminiApiEndpoint(
        decodeGemini({ apiEndpoint: "https://generativelanguage.googleapis.com" }),
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolveGeminiModel("gemini-2.5-flash-thinking")).toBe("gemini-2.5-flash");
    expect(resolveGeminiModel("flash")).toBe("gemini-2.5-flash");
    expect(resolveGeminiModel("pro")).toBe("gemini-2.5-pro");
    expect(resolveNvidiaModel("meta/llama-3.2-90b-vision-instruct")).toBe(
      "meta/llama-3.2-90b-vision-instruct",
    );
    expect(resolveNvidiaModel("llama-3.2-90b")).toBe("meta/llama-3.2-90b-vision-instruct");
    expect(resolveNvidiaModel("r1")).toBe("deepseek-ai/deepseek-v4-pro-0813");
  });

  it("retries transient NVIDIA rate-limit and gateway failures", () => {
    expect([429, 502, 503, 504].every(isRetryableNvidiaStatus)).toBe(true);
    expect(isRetryableNvidiaStatus(400)).toBe(false);
    expect(isRetryableNvidiaStatus(401)).toBe(false);
    expect(isRetryableNvidiaStatus(500)).toBe(false);
  });

  it("redacts API keys before settings are returned to the desktop client", () => {
    const geminiId = ProviderInstanceId.make("gemini");
    const nvidiaId = ProviderInstanceId.make("nvidia");
    const redacted = redactServerSettingsForClient({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [geminiId]: {
          driver: ProviderDriverKind.make("gemini"),
          enabled: true,
          config: { apiKey: "gemini-secret", apiEndpoint: "" },
        },
        [nvidiaId]: {
          driver: ProviderDriverKind.make("nvidia"),
          enabled: true,
          config: { apiKey: "nvidia-secret", apiEndpoint: "https://example.test/v1" },
        },
      },
    });

    expect(redacted.providerInstances[geminiId]?.config).toMatchObject({
      apiKey: "",
      apiKeyRedacted: true,
    });
    expect(redacted.providerInstances[nvidiaId]?.config).toMatchObject({
      apiKey: "",
      apiKeyRedacted: true,
    });

    const restored = restoreRedactedProviderConfigSecrets(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [geminiId]: {
            driver: ProviderDriverKind.make("gemini"),
            enabled: true,
            config: { apiKey: "gemini-secret", apiEndpoint: "" },
          },
        },
      },
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [geminiId]: redacted.providerInstances[geminiId]!,
        },
      },
    );
    expect(restored.providerInstances[geminiId]?.config).toMatchObject({
      apiKey: "gemini-secret",
    });
  });

  it("redacts and restores MCP header credentials", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      mcpServers: [
        {
          id: "remote",
          name: "Remote",
          enabled: true,
          transport: {
            type: "http" as const,
            url: "https://example.test/mcp",
            headers: [{ name: "Authorization", value: "Bearer secret" }],
          },
        },
      ],
    };
    const redacted = redactServerSettingsForClient(current);
    expect(redacted.mcpServers[0]?.transport).toMatchObject({
      headers: [{ name: "Authorization", value: "", valueRedacted: true }],
    });
    const restored = restoreRedactedProviderConfigSecrets(current, redacted);
    expect(restored.mcpServers[0]?.transport).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer secret" }],
    });
  });

  it.effect("runs chat turn and records history without MCP servers", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDirectChatAdapter({
        provider: ProviderDriverKind.make("gemini"),
        defaultModel: "gemini-2.5-flash",
        runChat: ({ model, history }) =>
          Effect.succeed(`Echo: ${history[0]?.content} using ${model}`),
      });
      const threadId = ThreadId.make("thread-direct-chat-no-mcp");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        runtimeMode: "full-access",
      });
      const result = yield* adapter.sendTurn({
        threadId,
        input: "Hello World",
      });
      expect(result.threadId).toBe(threadId);
      const read = yield* adapter.readThread(threadId);
      expect(read.turns).toHaveLength(1);
      expect((read.turns[0]?.items[0] as { response?: string })?.response).toBe(
        "Echo: Hello World using gemini-2.5-flash",
      );
    }),
  );

  it.effect("handles turn interruption cleanly", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDirectChatAdapter({
        provider: ProviderDriverKind.make("gemini"),
        defaultModel: "gemini-2.5-flash",
        runChat: ({ model, history }) =>
          Effect.succeed(`Echo: ${history[0]?.content} using ${model}`),
      });
      const threadId = ThreadId.make("thread-direct-chat-interrupt");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        runtimeMode: "full-access",
      });
      yield* adapter.interruptTurn(threadId);
    }),
  );

  it.effect("supports detached Swarm workers for direct-chat providers", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDirectChatAdapter({
        provider: ProviderDriverKind.make("gemini"),
        defaultModel: "gemini-2.5-flash",
        runChat: ({ history }) =>
          Effect.sleep("100 millis").pipe(Effect.as(`Worker: ${history.at(-1)?.content ?? ""}`)),
      });
      const threadId = ThreadId.make("thread-direct-chat-swarm");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("gemini"),
        runtimeMode: "full-access",
      });

      const worker = yield* adapter.launchSwarmAgent!({
        threadId,
        task: "Inspect the audio subsystem in parallel.",
        title: "Audio worker",
        workspaceStrategy: "shared",
      });
      expect(worker.agentId).toContain("shiryugen-swarm-");
      expect(worker.title).toBe("Audio worker");

      yield* adapter.messageSwarmAgent!({
        threadId,
        agentId: worker.agentId,
        message: "Also check the TTS route.",
      });
      yield* adapter.stopSwarmAgent!({ threadId, agentId: worker.agentId });
    }),
  );

  it.effect("handles remote model discovery errors gracefully by returning empty arrays", () =>
    Effect.gen(function* () {
      const nvidiaModels = yield* fetchNvidiaRemoteModels(
        "invalid-key",
        "https://invalid.endpoint.test/v1",
      );
      expect(nvidiaModels).toEqual([]);

      const geminiModels = yield* fetchGeminiRemoteModels(
        "invalid-key",
        "https://invalid.endpoint.test/v1beta",
      );
      expect(geminiModels).toEqual([]);
    }),
  );
});
