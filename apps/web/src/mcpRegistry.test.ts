import type {
  McpRegistryInstallOption,
  McpRegistryServer,
  McpServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  groupMcpRegistryServersByCategory,
  isMcpRegistryInstallConfigured,
  makeMcpRegistryServerConfig,
} from "./mcpRegistry.ts";

const registryServer: McpRegistryServer = {
  name: "io.example/weather-tools",
  title: "Weather Tools",
  description: "Weather tools",
  version: "1.0.0",
  category: "utilities",
  installs: [],
};

const remoteInstall: McpRegistryInstallOption = {
  id: "remote-0",
  label: "Remote HTTP",
  source: "remote",
  requiresConfiguration: false,
  transport: {
    type: "http",
    url: "https://weather.example.test/mcp",
    headers: [],
  },
};

describe("MCP Registry web helpers", () => {
  it("groups plugin search results into ordered category sections", () => {
    const groups = groupMcpRegistryServersByCategory([
      registryServer,
      {
        ...registryServer,
        name: "com.example/discord-tools",
        title: "Discord Tools",
        category: "communication",
      },
      {
        ...registryServer,
        name: "com.example/github-tools",
        title: "GitHub Tools",
        category: "developer-tools",
      },
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Communication",
      "Developer Tools",
      "Utilities",
    ]);
    expect(groups[0]?.servers.map((server) => server.title)).toEqual(["Discord Tools"]);
  });

  it("detects an already configured remote despite a trailing slash", () => {
    const existing: McpServerConfig[] = [
      {
        id: "weather",
        name: "Weather",
        enabled: true,
        transport: {
          type: "http",
          url: "https://weather.example.test/mcp/",
          headers: [],
        },
      },
    ];

    expect(isMcpRegistryInstallConfigured(existing, remoteInstall)).toBe(true);
  });

  it("compares stdio command arguments when detecting duplicates", () => {
    const install: McpRegistryInstallOption = {
      id: "npm-0",
      label: "Local npm",
      source: "npm",
      requiresConfiguration: false,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/tools@1.0.0"],
        environment: [],
      },
    };
    const existing: McpServerConfig[] = [
      {
        id: "other-tools",
        name: "Other tools",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@example/other@1.0.0"],
          environment: [],
        },
      },
    ];

    expect(isMcpRegistryInstallConfigured(existing, install)).toBe(false);
  });

  it("creates stable unique plugin ids without changing the install transport", () => {
    const existing: McpServerConfig[] = [
      {
        id: "plugin-io-example-weather-tools",
        name: "Old Weather",
        enabled: true,
        transport: { type: "http", url: "https://old.example.test/mcp", headers: [] },
      },
    ];

    expect(makeMcpRegistryServerConfig(registryServer, remoteInstall, existing)).toEqual({
      id: "plugin-io-example-weather-tools-2",
      name: "Weather Tools",
      enabled: true,
      transport: remoteInstall.transport,
    });
  });
});
