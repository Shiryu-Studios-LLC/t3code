import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { externalMcpServersForThread } from "./ExternalMcpProviderConfig.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

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

async function connectServer(server: McpServerConfig): Promise<ConnectedServer> {
  const client = new Client({ name: "t3-studio", version: "0.0.33" });
  const transport =
    server.transport.type === "http"
      ? new StreamableHTTPClientTransport(new URL(server.transport.url), {
          requestInit: {
            headers: Object.fromEntries(
              server.transport.headers.map((header) => [header.name, header.value]),
            ),
          },
        })
      : new StdioClientTransport({
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
  await client.connect(transport as Parameters<Client["connect"]>[0]);
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

async function openMcpToolSetPromise(threadId: ThreadId): Promise<McpToolSet> {
  const connected: Array<ConnectedServer> = [];
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
    const tools: Array<BridgedMcpTool> = [];
    for (const [serverIndex, server] of connected.entries()) {
      try {
        const listed = await server.client.listTools();
        for (const tool of listed.tools) {
          const prefix = safeToolName(server.id).slice(0, 20);
          const suffix = safeToolName(tool.name).slice(0, 38);
          let bridgedName = `mcp_${prefix}_${suffix}`.slice(0, 64);
          if (calls.has(bridgedName)) bridgedName = `${bridgedName.slice(0, 60)}_${serverIndex}`;
          calls.set(bridgedName, { server, toolName: tool.name });
          tools.push({
            name: bridgedName,
            title: `${server.name}: ${tool.title ?? tool.name}`,
            description: tool.description ?? `Use ${tool.name} from ${server.name}.`,
            inputSchema: tool.inputSchema,
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

    return {
      tools,
      call: async (name, input) => {
        const target = calls.get(name);
        if (!target) throw new Error(`Unknown MCP tool '${name}'.`);
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

export const openMcpToolSet = (threadId: ThreadId) =>
  Effect.tryPromise({
    try: () => openMcpToolSetPromise(threadId),
    catch: (cause) => new McpToolBridgeError({ cause }),
  });

export const withMcpToolSet = <A, E, R>(
  threadId: ThreadId,
  use: (toolSet: McpToolSet) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(openMcpToolSet(threadId), use, (toolSet) =>
    Effect.promise(() => toolSet.close()),
  );
