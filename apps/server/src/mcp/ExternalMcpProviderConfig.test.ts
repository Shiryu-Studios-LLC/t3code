import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  externalMcpServersForAcp,
  externalMcpServersForClaude,
  externalMcpServersForCodex,
  externalMcpServersForOpenCode,
} from "./ExternalMcpProviderConfig.ts";
import {
  clearAllExternalMcpProviderServers,
  setExternalMcpProviderServers,
} from "./ExternalMcpProviderSession.ts";

const threadId = ThreadId.make("thread-external-mcp");

afterEach(clearAllExternalMcpProviderServers);

describe("external MCP provider configuration", () => {
  it("projects enabled HTTP and stdio servers into every native provider shape", () => {
    setExternalMcpProviderServers(threadId, [
      {
        id: "remote-tools",
        name: "Remote tools",
        enabled: true,
        transport: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
        },
      },
      {
        id: "local-tools",
        name: "Local tools",
        enabled: true,
        transport: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          environment: [{ name: "API_KEY", value: "secret" }],
        },
      },
      {
        id: "disabled-tools",
        name: "Disabled tools",
        enabled: false,
        transport: { type: "http", url: "https://disabled.example.test/mcp", headers: [] },
      },
    ]);

    expect(externalMcpServersForAcp(threadId)).toHaveLength(2);
    expect(externalMcpServersForClaude(threadId)).toMatchObject({
      "t3-user-remote-tools": { type: "http", url: "https://mcp.example.test/mcp" },
      "t3-user-local-tools": { type: "stdio", command: "node" },
    });
    expect(externalMcpServersForOpenCode(threadId)).toHaveLength(2);
    expect(externalMcpServersForCodex(threadId).args.join(" ")).toContain(
      "mcp_servers.t3-user-remote-tools.url",
    );
    expect(externalMcpServersForCodex(threadId).args.join(" ")).toContain(
      "mcp_servers.t3-user-local-tools.command",
    );
  });
});
