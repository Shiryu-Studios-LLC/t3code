import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  clearAllExternalMcpProviderServers,
  setExternalMcpProviderServers,
} from "./ExternalMcpProviderSession.ts";
import { withMcpToolSet } from "./McpToolBridge.ts";

describe("MCP Tool Bridge", () => {
  it.effect("handles sessions without any MCP servers connected", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-no-mcp");
        setExternalMcpProviderServers(threadId, []);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools).toHaveLength(0);
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );

  it.effect("ignores disabled MCP servers", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-disabled-mcp");
        setExternalMcpProviderServers(threadId, [
          {
            id: "echo-disabled",
            name: "Echo (Disabled)",
            enabled: false,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url))],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools).toHaveLength(0);
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );

  it.effect("lists and invokes tools from a configured stdio MCP server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-mcp-tool-bridge");
        setExternalMcpProviderServers(threadId, [
          {
            id: "echo",
            name: "Echo",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url))],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools).toHaveLength(1);
            expect(toolSet.tools[0]?.readOnly).toBe(true);
            const result = yield* Effect.promise(() =>
              toolSet.call(toolSet.tools[0]!.name, { message: "MCP OK" }),
            );
            expect(result).toBe("MCP OK");
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );

  it.effect("gracefully tolerates offline/failing MCP servers while retaining working tools", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-resilient-mcp");
        setExternalMcpProviderServers(threadId, [
          {
            id: "unreachable-http",
            name: "Unreachable Server",
            enabled: true,
            transport: {
              type: "http",
              url: "http://127.0.0.1:59999/non-existent-mcp",
              headers: [],
            },
          },
          {
            id: "echo-working",
            name: "Working Echo Server",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url))],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, (toolSet) =>
          Effect.gen(function* () {
            // Unreachable server failed gracefully, working echo server connected and exposed tool
            expect(toolSet.tools).toHaveLength(1);
            expect(toolSet.tools[0]?.name).toContain("echo");
            const result = yield* Effect.promise(() =>
              toolSet.call(toolSet.tools[0]!.name, { message: "Resilience verified" }),
            );
            expect(result).toBe("Resilience verified");
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );
});
