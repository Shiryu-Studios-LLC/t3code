import type { McpServerConfig, ThreadId } from "@t3tools/contracts";

import { readExternalMcpProviderServers } from "./ExternalMcpProviderSession.ts";

function runtimeName(server: McpServerConfig): string {
  const normalized = server.id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `t3-user-${normalized || "server"}`;
}

function headerRecord(server: McpServerConfig): Record<string, string> {
  if (server.transport.type !== "http") return {};
  return Object.fromEntries(server.transport.headers.map((header) => [header.name, header.value]));
}

function environmentRecord(server: McpServerConfig): Record<string, string> {
  if (server.transport.type !== "stdio") return {};
  return Object.fromEntries(
    server.transport.environment.map((variable) => [variable.name, variable.value]),
  );
}

export function externalMcpServersForThread(threadId: ThreadId): ReadonlyArray<McpServerConfig> {
  return readExternalMcpProviderServers(threadId).filter((server) => server.enabled !== false);
}

export function externalMcpServersForAcp(threadId: ThreadId) {
  return externalMcpServersForThread(threadId).map((server) =>
    server.transport.type === "http"
      ? {
          type: "http" as const,
          name: runtimeName(server),
          url: server.transport.url,
          headers: server.transport.headers.map((header) => ({
            name: header.name,
            value: header.value,
          })),
        }
      : {
          type: "stdio" as const,
          name: runtimeName(server),
          command: server.transport.command,
          args: [...server.transport.args],
          env: server.transport.environment.map((variable) => ({
            name: variable.name,
            value: variable.value,
          })),
        },
  );
}

export function externalMcpServersForClaude(threadId: ThreadId) {
  return Object.fromEntries(
    externalMcpServersForThread(threadId).map((server) => [
      runtimeName(server),
      server.transport.type === "http"
        ? {
            type: "http" as const,
            url: server.transport.url,
            headers: headerRecord(server),
          }
        : {
            type: "stdio" as const,
            command: server.transport.command,
            args: [...server.transport.args],
            env: environmentRecord(server),
          },
    ]),
  );
}

export function externalMcpServersForOpenCode(threadId: ThreadId) {
  return externalMcpServersForThread(threadId).map((server) => ({
    name: runtimeName(server),
    config:
      server.transport.type === "http"
        ? {
            type: "remote" as const,
            url: server.transport.url,
            headers: headerRecord(server),
            oauth: false as const,
          }
        : {
            type: "local" as const,
            command: [server.transport.command, ...server.transport.args],
            environment: environmentRecord(server),
          },
  }));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlStringRecord(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")}}`;
}

export function externalMcpServersForCodex(threadId: ThreadId): {
  readonly args: ReadonlyArray<string>;
} {
  const args: Array<string> = [];
  for (const server of externalMcpServersForThread(threadId)) {
    const prefix = `mcp_servers.${runtimeName(server)}`;
    if (server.transport.type === "http") {
      args.push("-c", `${prefix}.url=${tomlString(server.transport.url)}`);
      const headers = headerRecord(server);
      if (Object.keys(headers).length > 0) {
        args.push("-c", `${prefix}.http_headers=${tomlStringRecord(headers)}`);
      }
      continue;
    }
    args.push("-c", `${prefix}.command=${tomlString(server.transport.command)}`);
    if (server.transport.args.length > 0) {
      args.push("-c", `${prefix}.args=${tomlStringArray(server.transport.args)}`);
    }
    const environment = environmentRecord(server);
    if (Object.keys(environment).length > 0) {
      args.push("-c", `${prefix}.env=${tomlStringRecord(environment)}`);
    }
  }
  return { args };
}
