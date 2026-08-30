import type { McpServerConfig, ThreadId } from "@t3tools/contracts";

const serversByThread = new Map<ThreadId, ReadonlyArray<McpServerConfig>>();
let globalExternalServers: ReadonlyArray<McpServerConfig> = [];

export function setGlobalExternalMcpServers(servers: ReadonlyArray<McpServerConfig>): void {
  globalExternalServers = servers.filter((server) => server.enabled);
}

export function setExternalMcpProviderServers(
  threadId: ThreadId,
  servers: ReadonlyArray<McpServerConfig>,
): void {
  serversByThread.set(
    threadId,
    servers.filter((server) => server.enabled),
  );
  setGlobalExternalMcpServers(servers);
}

export function readExternalMcpProviderServers(threadId: ThreadId): ReadonlyArray<McpServerConfig> {
  const perThread = serversByThread.get(threadId);
  if (perThread && perThread.length > 0) {
    return perThread;
  }
  return globalExternalServers;
}

export function clearExternalMcpProviderServers(threadId: ThreadId): void {
  serversByThread.delete(threadId);
}

export function clearAllExternalMcpProviderServers(): void {
  serversByThread.clear();
  globalExternalServers = [];
}
