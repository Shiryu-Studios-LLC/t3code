// @effect-diagnostics globalTimers:off - MCP SDK connection promises require a wall-clock timeout at this boundary.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpServerConfig, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { externalMcpServersForThread } from "./ExternalMcpProviderConfig.ts";
import * as ExternalMcpProviderSession from "./ExternalMcpProviderSession.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import { restoreRedactedMcpServer } from "../serverSettings.ts";
import { executeWorkspaceTool, isWorkspaceTool, WORKSPACE_TOOLS } from "./WorkspaceTools.ts";

export interface BridgedMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface McpToolSet {
  readonly tools: ReadonlyArray<BridgedMcpTool>;
  readonly call: (name: string, input: unknown) => Promise<string>;
  readonly close: () => Promise<void>;
}

export interface McpToolCallOutcome {
  readonly content: string;
  readonly isError: boolean;
}

const SHIRYUGEN_TOOL_SEARCH: BridgedMcpTool = {
  name: "shiryugen_tool_search",
  title: "ShiryuGen: Find capabilities",
  description:
    "Search and activate ShiryuGen tools only when needed. Use this to discover Swarm workers, image generation/editing, plugins, skills, previews, project/workspace operations, and connected integrations without loading every tool schema into every turn.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Capability or task to find, for example 'swarm', 'generate image', 'plugins', or 'preview click'.",
      },
      limit: {
        type: "number",
        description: "Maximum tools to activate for the next model round (default 6, max 12).",
      },
    },
    required: ["query"],
  },
  readOnly: true,
};

function searchToolScore(tool: BridgedMcpTool, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const haystack = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
  if (haystack.includes(normalized)) return 100 + normalized.length;
  const terms = normalized.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (tool.name.toLowerCase().includes(term)) score += 12;
    if (tool.title.toLowerCase().includes(term)) score += 8;
    if (tool.description.toLowerCase().includes(term)) score += 4;
  }
  return score;
}

interface ConnectedServer {
  readonly id: string;
  readonly name: string;
  readonly client: Client;
}

export class McpToolBridgeError extends Schema.TaggedErrorClass<McpToolBridgeError>()(
  "McpToolBridgeError",
  { cause: Schema.Defect() },
) {}

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function configuredServers(threadId: ThreadId): ReadonlyArray<McpServerConfig> {
  const builtIn = McpProviderSession.readMcpProviderSession(threadId);
  return [
    ...(builtIn
      ? [
          {
            id: "t3-code",
            name: "T3 Studio",
            enabled: true,
            transport: {
              type: "http" as const,
              url: builtIn.endpoint,
              headers: [{ name: "Authorization", value: builtIn.authorizationHeader }],
            },
          },
        ]
      : []),
    ...externalMcpServersForThread(threadId),
  ];
}

async function connectWithTimeout(
  server: McpServerConfig,
  clientName: string,
  timeoutMs = 10000,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: clientName, version: "0.0.33" });

  if (server.transport.type === "http") {
    const url = new URL(server.transport.url);
    const headers = Object.fromEntries(
      server.transport.headers.map((header) => [header.name, header.value]),
    );

    try {
      const streamableTransport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await Promise.race([
        client.connect(streamableTransport as Parameters<Client["connect"]>[0]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out after 10s")), timeoutMs),
        ),
      ]);
    } catch (streamableError) {
      // Fall back to SSE transport if Streamable HTTP encounters 404 or protocol error
      try {
        const sseTransport = new SSEClientTransport(url, {
          requestInit: { headers },
        });
        await Promise.race([
          client.connect(sseTransport as Parameters<Client["connect"]>[0]),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection timed out after 10s")), timeoutMs),
          ),
        ]);
      } catch {
        throw streamableError;
      }
    }
  } else {
    const stdioTransport = new StdioClientTransport({
      command: server.transport.command,
      args: [...server.transport.args],
      env: {
        ...processEnvironment(),
        ...Object.fromEntries(
          server.transport.environment.map((variable) => [variable.name, variable.value]),
        ),
      },
      stderr: "pipe",
    });
    await Promise.race([
      client.connect(stdioTransport as Parameters<Client["connect"]>[0]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out after 10s")), timeoutMs),
      ),
    ]);
  }

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {}
    },
  };
}

async function connectServer(server: McpServerConfig): Promise<ConnectedServer> {
  const { client } = await connectWithTimeout(server, "t3-studio", 10000);
  return { id: server.id, name: server.name, client };
}

function resultText(result: unknown): string {
  const record =
    result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .flatMap((item) =>
      item !== null &&
      typeof item === "object" &&
      (item as { readonly type?: unknown }).type === "text" &&
      typeof (item as { readonly text?: unknown }).text === "string"
        ? [(item as { readonly text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
  if (text.length > 0) return text;
  if (record.structuredContent !== undefined) return JSON.stringify(record.structuredContent);
  if (record.toolResult !== undefined) return JSON.stringify(record.toolResult);
  return JSON.stringify(content);
}

export async function callMcpToolForModel(
  toolSet: Pick<McpToolSet, "call">,
  name: string,
  input: unknown,
): Promise<McpToolCallOutcome> {
  try {
    return { content: await toolSet.call(name, input), isError: false };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.trim() : "";
    return {
      content: `MCP tool '${name}' failed${detail ? `: ${detail}` : "."} Continue without this tool.`,
      isError: true,
    };
  }
}

export interface OpenMcpToolSetOptions {
  readonly workspaceCwd?: string;
  readonly includeWorkspaceTools?: boolean;
}

async function openMcpToolSetPromise(
  threadId: ThreadId,
  options: OpenMcpToolSetOptions = {},
): Promise<McpToolSet> {
  const connected: Array<ConnectedServer> = [];
  const workspaceCwd = options.workspaceCwd;
  const normalizedWorkspaceCwd = workspaceCwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  const isGeneralChatWorkspace =
    normalizedWorkspaceCwd === "~/.t3/general-chat" ||
    normalizedWorkspaceCwd?.endsWith("/.t3/general-chat") === true;
  const includeWorkspaceTools = options.includeWorkspaceTools ?? !isGeneralChatWorkspace;

  try {
    for (const server of configuredServers(threadId)) {
      try {
        connected.push(await connectServer(server));
      } catch (error) {
        // @effect-diagnostics-next-line globalConsole:off - async context; Effect.logWarning unavailable
        console.warn(
          `[mcp] Failed to connect to MCP server "${server.name}" (${server.id}):`,
          error,
        );
      }
    }

    const calls = new Map<
      string,
      { readonly server: ConnectedServer; readonly toolName: string }
    >();
    const catalog: Array<BridgedMcpTool> = includeWorkspaceTools ? [...WORKSPACE_TOOLS] : [];

    for (const [serverIndex, server] of connected.entries()) {
      try {
        const listed = await server.client.listTools();
        for (const tool of listed.tools) {
          const prefix = safeToolName(server.id).slice(0, 20);
          const suffix = safeToolName(tool.name).slice(0, 38);
          let bridgedName = `mcp_${prefix}_${suffix}`.slice(0, 64);
          if (calls.has(bridgedName)) bridgedName = `${bridgedName.slice(0, 60)}_${serverIndex}`;
          calls.set(bridgedName, { server, toolName: tool.name });
          catalog.push({
            name: bridgedName,
            title: `${server.name}: ${tool.title ?? tool.name}`,
            description: tool.description ?? `Use ${tool.name} from ${server.name}.`,
            inputSchema: sanitizeInputSchema(tool.inputSchema),
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        }
      } catch (error) {
        // @effect-diagnostics-next-line globalConsole:off - async context; Effect.logWarning unavailable
        console.warn(
          `[mcp] Failed to list tools from MCP server "${server.name}" (${server.id}):`,
          error,
        );
      }
    }

    // Keep every discovered capability in a private catalog, but only expose a
    // compact baseline. `shiryugen_tool_search` promotes matching schemas into
    // this same array, so adapters that perform another tool round immediately
    // see the newly activated tools without any system-prompt expansion.
    const tools: Array<BridgedMcpTool> = [
      SHIRYUGEN_TOOL_SEARCH,
      ...(includeWorkspaceTools ? WORKSPACE_TOOLS : []),
    ];
    const visibleToolNames = new Set(tools.map((tool) => tool.name));

    return {
      tools,
      call: async (name, input) => {
        if (name === SHIRYUGEN_TOOL_SEARCH.name) {
          const params = (input && typeof input === "object" ? input : {}) as {
            query?: string;
            limit?: number;
          };
          const query = params.query?.trim() ?? "";
          if (!query) throw new Error("Missing required 'query' argument.");
          const limit = Math.min(Math.max(Math.trunc(params.limit ?? 6), 1), 12);
          const matches = catalog
            .map((tool) => ({ tool, score: searchToolScore(tool, query) }))
            .filter(({ score }) => score > 0)
            .toSorted(
              (left, right) =>
                right.score - left.score || left.tool.name.localeCompare(right.tool.name),
            )
            .slice(0, limit);

          for (const { tool } of matches) {
            if (visibleToolNames.has(tool.name)) continue;
            visibleToolNames.add(tool.name);
            tools.push(tool);
          }

          return JSON.stringify({
            query,
            activated: matches.map(({ tool }) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              readOnly: tool.readOnly,
            })),
            note:
              matches.length > 0
                ? "Activated tools are available on the next tool-call round."
                : "No matching ShiryuGen capability was found.",
          });
        }
        if (isWorkspaceTool(name)) {
          return await executeWorkspaceTool(name, input, workspaceCwd);
        }
        const target = calls.get(name);
        if (!target) throw new Error(`Unknown tool '${name}'.`);
        const result = await target.server.client.callTool({
          name: target.toolName,
          arguments:
            input !== null && typeof input === "object" && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
        if (result.isError) throw new Error(resultText(result));
        return resultText(result);
      },
      close: async () => {
        await Promise.allSettled(connected.map(({ client }) => client.close()));
      },
    };
  } catch (cause) {
    await Promise.allSettled(connected.map(({ client }) => client.close()));
    throw cause;
  }
}

export function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const cloned = { ...(schema as Record<string, unknown>) };
  delete cloned.$schema;
  if (!cloned.type) {
    cloned.type = "object";
  }
  if (!cloned.properties) {
    cloned.properties = {};
  }
  return cloned;
}

export const openMcpToolSet = (threadId: ThreadId, options?: OpenMcpToolSetOptions | string) => {
  const resolvedOptions: OpenMcpToolSetOptions =
    typeof options === "string" ? { workspaceCwd: options } : (options ?? {});
  return Effect.tryPromise({
    try: () => openMcpToolSetPromise(threadId, resolvedOptions),
    catch: (cause) => new McpToolBridgeError({ cause }),
  });
};

export function withMcpToolSet<A, E, R>(
  threadId: ThreadId,
  use: (toolSet: McpToolSet) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpToolBridgeError, R>;
export function withMcpToolSet<A, E, R>(
  threadId: ThreadId,
  optionsOrCwd: OpenMcpToolSetOptions | string | undefined,
  use: (toolSet: McpToolSet) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpToolBridgeError, R>;
export function withMcpToolSet<A, E, R>(
  threadId: ThreadId,
  optionsOrUse:
    | OpenMcpToolSetOptions
    | string
    | undefined
    | ((toolSet: McpToolSet) => Effect.Effect<A, E, R>),
  maybeUse?: (toolSet: McpToolSet) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpToolBridgeError, R> {
  const use = typeof optionsOrUse === "function" ? optionsOrUse : maybeUse!;
  const options = typeof optionsOrUse === "function" ? undefined : optionsOrUse;
  return Effect.acquireUseRelease(openMcpToolSet(threadId, options), use, (toolSet) =>
    Effect.promise(() => toolSet.close()),
  );
}

export interface McpServerHealthCheckResult {
  readonly serverId: string;
  readonly serverName: string;
  readonly healthy: boolean;
  readonly error?: string;
  readonly toolCount?: number;
}

export async function checkSingleMcpServerHealth(
  server: McpServerConfig,
  storedServer?: McpServerConfig,
): Promise<McpServerHealthCheckResult> {
  try {
    const effectiveServer = storedServer ? restoreRedactedMcpServer(storedServer, server) : server;
    const { client, close } = await connectWithTimeout(
      effectiveServer,
      "t3-studio-healthcheck",
      10000,
    );
    try {
      const listed = await client.listTools();
      return {
        serverId: server.id,
        serverName: server.name,
        healthy: true,
        toolCount: listed.tools.length,
      };
    } finally {
      await close();
    }
  } catch (error) {
    return {
      serverId: server.id,
      serverName: server.name,
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// @effect-diagnostics globalTimers:off - MCP SDK connection promises require a wall-clock timeout at this boundary.
