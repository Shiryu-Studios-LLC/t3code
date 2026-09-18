import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  clearAllExternalMcpProviderServers,
  setExternalMcpProviderServers,
} from "./ExternalMcpProviderSession.ts";
import {
  callMcpToolForModel,
  checkSingleMcpServerHealth,
  sanitizeInputSchema,
  withMcpToolSet,
} from "./McpToolBridge.ts";

describe("MCP Tool Bridge", () => {
  it("turns a failed tool call into model-readable output", async () => {
    const outcome = await callMcpToolForModel(
      {
        call: () => Promise.reject(new Error("preview host unavailable")),
      },
      "mcp_t3-code_preview_snapshot",
      {},
    );

    expect(outcome).toEqual({
      content:
        "MCP tool 'mcp_t3-code_preview_snapshot' failed: preview host unavailable Continue without this tool.",
      isError: true,
    });
  });

  it.effect(
    "handles sessions without external MCP servers by providing built-in workspace tools",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const threadId = ThreadId.make("thread-no-mcp");
          setExternalMcpProviderServers(threadId, []);
          return threadId;
        }),
        (threadId) =>
          withMcpToolSet(threadId, (toolSet) =>
            Effect.gen(function* () {
              expect(toolSet.tools.length).toBeGreaterThan(0);
              const toolNames = toolSet.tools.map((t) => t.name);
              expect(toolNames).toContain("shiryugen_tool_search");
              expect(toolNames).toContain("execute_command");
              expect(toolNames).toContain("read_file");
              expect(toolNames).toContain("write_file");
              expect(toolNames).toContain("list_directory");
              expect(toolNames).toContain("grep_search");
            }),
          ),
        () => Effect.sync(clearAllExternalMcpProviderServers),
      ),
  );

  it.effect("can exclude workspace tools when only external servers are requested", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-pure-mcp");
        setExternalMcpProviderServers(threadId, []);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, { includeWorkspaceTools: false }, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools.map((tool) => tool.name)).toEqual(["shiryugen_tool_search"]);
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );

  it.effect("withholds built-in workspace tools for the isolated General Chat cwd", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const threadId = ThreadId.make("thread-general-chat");
        setExternalMcpProviderServers(threadId, []);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, "/home/test/.t3/general-chat", (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools.map((tool) => tool.name)).toEqual(["shiryugen_tool_search"]);
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
              args: [
                NodeURL.fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url)),
              ],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, { includeWorkspaceTools: false }, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools.map((tool) => tool.name)).toEqual(["shiryugen_tool_search"]);
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
              args: [
                NodeURL.fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url)),
              ],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, { includeWorkspaceTools: false }, (toolSet) =>
          Effect.gen(function* () {
            expect(toolSet.tools.map((tool) => tool.name)).toEqual(["shiryugen_tool_search"]);
            const searchResult = yield* Effect.promise(() =>
              toolSet.call("shiryugen_tool_search", { query: "echo" }),
            );
            expect(searchResult).toContain("Echo");
            const echoTool = toolSet.tools.find((tool) => tool.name !== "shiryugen_tool_search");
            expect(echoTool?.readOnly).toBe(true);
            const result = yield* Effect.promise(() =>
              toolSet.call(echoTool!.name, { message: "MCP OK" }),
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
              args: [
                NodeURL.fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url)),
              ],
              environment: [],
            },
          },
        ]);
        return threadId;
      }),
      (threadId) =>
        withMcpToolSet(threadId, { includeWorkspaceTools: false }, (toolSet) =>
          Effect.gen(function* () {
            // Unreachable server failed gracefully. The working tool remains in the
            // private catalog until the model asks for the relevant capability.
            expect(toolSet.tools.map((tool) => tool.name)).toEqual(["shiryugen_tool_search"]);
            yield* Effect.promise(() => toolSet.call("shiryugen_tool_search", { query: "echo" }));
            const echoTool = toolSet.tools.find((tool) => tool.name !== "shiryugen_tool_search");
            expect(echoTool?.name).toContain("echo");
            const result = yield* Effect.promise(() =>
              toolSet.call(echoTool!.name, { message: "Resilience verified" }),
            );
            expect(result).toBe("Resilience verified");
          }),
        ),
      () => Effect.sync(clearAllExternalMcpProviderServers),
    ),
  );

  it("sanitizes tool input schema for direct chat models", () => {
    const rawSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const sanitized = sanitizeInputSchema(rawSchema);
    expect(sanitized).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect("$schema" in sanitized).toBe(false);
  });

  it("checks single server health correctly for stdio servers", async () => {
    const result = await checkSingleMcpServerHealth({
      id: "echo-check",
      name: "Echo Health Check",
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [NodeURL.fileURLToPath(new URL("./fixtures/echoMcpServer.mjs", import.meta.url))],
        environment: [],
      },
    });
    expect(result.healthy).toBe(true);
  });

  it("checks live DevSpace MCP health with stored token", async () => {
    const result = await checkSingleMcpServerHealth({
      id: "mcp-server-1",
      name: "DevspaceMCP",
      enabled: true,
      transport: {
        type: "http",
        url: "https://devspace.shiryu.org/mcp",
        headers: [
          {
            name: "Authorization",
            value: "",
            valueRedacted: true,
          },
        ],
      },
    });

    expect(result.serverId).toBe("mcp-server-1");
  });

  it.effect("executes workspace tools (command, file, directory, grep) correctly", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-workspace-tools");
      const toolSet = yield* Effect.promise(() =>
        import("./McpToolBridge.ts").then((m) =>
          Effect.runPromise(m.openMcpToolSet(threadId, { workspaceCwd: process.cwd() })),
        ),
      );

      try {
        // execute_command
        const cmdResult = yield* Effect.promise(() =>
          toolSet.call("execute_command", {
            command: "node -e \"console.log('workspace-tool-ok')\"",
          }),
        );
        expect(cmdResult).toContain("workspace-tool-ok");

        // list_directory
        const listResult = yield* Effect.promise(() =>
          toolSet.call("list_directory", { path: "." }),
        );
        expect(listResult).toContain("[FILE]");

        // grep_search
        const grepResult = yield* Effect.promise(() =>
          toolSet.call("grep_search", { query: "workspace-tool-ok", path: "." }),
        );
        expect(typeof grepResult).toBe("string");
      } finally {
        yield* Effect.promise(() => toolSet.close());
      }
    }),
  );
});
