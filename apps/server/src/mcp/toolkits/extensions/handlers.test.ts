import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerSettings from "../../../serverSettings.ts";

const invocation = {
  environmentId: EnvironmentId.make("environment-extension-tools-test"),
  threadId: ThreadId.make("thread-extension-tools-test"),
  providerSessionId: "provider-session-extension-tools-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  // Extension management is an always-available authenticated T3 capability;
  // it must not disappear when preview/browser access is disabled.
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "extension-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const SettingsLive = ServerSettings.layerTest({
  mcpServers: [
    {
      id: "plugin-weather",
      name: "Weather Tools",
      enabled: true,
      transport: {
        type: "http",
        url: "https://weather.example.test/mcp",
        headers: [],
      },
    },
  ],
  t3Skills: [
    {
      id: "t3-skill-stream",
      name: "stream-setup",
      displayName: "Stream Setup",
      description: "Prepare a streaming session.",
      instructions: "Check the streaming stack.",
      enabled: true,
    },
  ],
});

const TestLayer = McpHttpServer.ExtensionManagementToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SettingsLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("lists and toggles installed plugins through the T3 agent toolkit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const searchTool = server.tools.find(({ tool }) => tool.name === "t3_plugin_catalog_search");
      const toggleTool = server.tools.find(({ tool }) => tool.name === "t3_plugin_set_enabled");
      expect(searchTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(searchTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(toggleTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(toggleTool?.tool.annotations?.destructiveHint).toBe(true);

      const before = yield* callTool("t3_plugin_list_installed");
      expect(before.structuredContent).toEqual({
        plugins: [
          {
            id: "plugin-weather",
            name: "Weather Tools",
            enabled: true,
            transport: "http",
          },
        ],
      });

      const toggled = yield* callTool("t3_plugin_set_enabled", {
        plugin: "Weather Tools",
        enabled: false,
      });
      expect(toggled.structuredContent).toMatchObject({
        id: "plugin-weather",
        enabled: false,
        sessionRefreshRecommended: true,
      });

      const after = yield* callTool("t3_plugin_list_installed");
      expect(after.structuredContent).toMatchObject({
        plugins: [{ id: "plugin-weather", enabled: false }],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("lists and toggles T3 Skills through the T3 agent toolkit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const before = yield* callTool("t3_skill_list");
      expect(before.structuredContent).toMatchObject({
        skills: [{ id: "t3-skill-stream", name: "stream-setup", enabled: true }],
      });

      const toggled = yield* callTool("t3_skill_set_enabled", {
        skill: "stream-setup",
        enabled: false,
      });
      expect(toggled.structuredContent).toMatchObject({
        id: "t3-skill-stream",
        enabled: false,
      });

      const after = yield* callTool("t3_skill_list");
      expect(after.structuredContent).toMatchObject({
        skills: [{ id: "t3-skill-stream", enabled: false }],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);
