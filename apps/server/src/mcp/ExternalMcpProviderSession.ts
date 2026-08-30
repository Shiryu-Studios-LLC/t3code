import type { McpServerConfig, ThreadId } from "@t3tools/contracts";

const serversByThread = new Map<ThreadId, ReadonlyArray<McpServerConfig>>();

export function setExternalMcpProviderServers(
  threadId: ThreadId,
  servers: ReadonlyArray<McpServerConfig>,
): void {
  serversByThread.set(
    threadId,
    servers.filter((server) => server.enabled),
  );
}

export function readExternalMcpProviderServers(threadId: ThreadId): ReadonlyArray<McpServerConfig> {
  return serversByThread.get(threadId) ?? [];
}

export function clearExternalMcpProviderServers(threadId: ThreadId): void {
  serversByThread.delete(threadId);
}

export function clearAllExternalMcpProviderServers(): void {
  serversByThread.clear();
}
