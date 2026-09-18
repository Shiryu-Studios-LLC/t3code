import { describe, expect, it } from "@effect/vitest";

import { classifyMcpRegistryServer, summarizeRegistryServer } from "./McpRegistry.ts";

describe("MCP Registry", () => {
  it("categorizes registry entries into T3 plugin sections", () => {
    expect(
      classifyMcpRegistryServer({
        name: "io.github/example-github-tools",
        title: "GitHub Tools",
        description: "Manage repositories and pull requests.",
      }),
    ).toBe("developer-tools");
    expect(
      classifyMcpRegistryServer({
        name: "com.example/food-delivery",
        title: "Food Delivery",
        description: "Search restaurants and manage food orders.",
      }),
    ).toBe("commerce-delivery");
    expect(
      classifyMcpRegistryServer({
        name: "io.example/weather",
        title: "Weather",
        description: "Current conditions and forecast tools.",
      }),
    ).toBe("utilities");
    expect(
      classifyMcpRegistryServer({
        name: "io.example/mystery",
        title: "Mystery Tool",
        description: "A specialized integration with no known category.",
      }),
    ).toBe("other");
  });

  it("turns a Streamable HTTP remote into a T3 HTTP install", () => {
    const result = summarizeRegistryServer({
      name: "io.example/weather",
      title: "Weather",
      description: "Weather tools",
      version: "1.2.3",
      remotes: [
        {
          type: "streamable-http",
          url: "https://weather.example.test/mcp",
          headers: [],
        },
      ],
    });

    expect(result.installs).toEqual([
      {
        id: "remote-0",
        label: "Remote HTTP",
        source: "remote",
        requiresConfiguration: false,
        transport: {
          type: "http",
          url: "https://weather.example.test/mcp",
          headers: [],
        },
      },
    ]);
  });

  it("marks unresolved required remote headers as setup-required", () => {
    const result = summarizeRegistryServer({
      name: "io.example/private",
      description: "Private tools",
      version: "1.0.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://private.example.test/mcp",
          headers: [
            {
              name: "Authorization",
              description: "API token",
              isRequired: true,
              isSecret: true,
            },
          ],
        },
      ],
    });

    expect(result.installs[0]).toMatchObject({
      requiresConfiguration: true,
      transport: {
        type: "http",
        headers: [{ name: "Authorization", value: "" }],
      },
    });
  });

  it("does not auto-install remotes whose URL still contains registry variables", () => {
    const result = summarizeRegistryServer({
      name: "io.example/tenant",
      description: "Tenant tools",
      version: "1.0.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://{tenant}.example.test/mcp",
        },
      ],
    });

    expect(result.installs).toEqual([]);
  });

  it("turns a simple npm stdio package into an npx install", () => {
    const result = summarizeRegistryServer({
      name: "io.example/npm-tools",
      description: "Local npm tools",
      version: "2.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/mcp-tools",
          version: "2.0.0",
          runtimeHint: "npx",
          transport: { type: "stdio" },
          environmentVariables: [
            {
              name: "API_KEY",
              description: "Service API key",
              isRequired: true,
              isSecret: true,
            },
          ],
        },
      ],
    });

    expect(result.installs).toEqual([
      {
        id: "npm-0",
        label: "Local npm",
        source: "npm",
        requiresConfiguration: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@example/mcp-tools@2.0.0"],
          environment: [{ name: "API_KEY", value: "" }],
        },
      },
    ]);
  });

  it("leaves npm packages with unresolved package arguments for manual setup", () => {
    const result = summarizeRegistryServer({
      name: "io.example/argument-tools",
      description: "Argument tools",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "argument-tools",
          transport: { type: "stdio" },
          packageArguments: [{ type: "named", name: "--workspace" }],
        },
      ],
    });

    expect(result.installs).toEqual([]);
  });

  it("keeps the first safe HTTPS registry icon and rejects unsafe icon URLs", () => {
    const result = summarizeRegistryServer({
      name: "io.example/icon-tools",
      description: "Tools with an icon",
      version: "1.0.0",
      icons: [
        { src: "http://example.test/insecure.png", mimeType: "image/png" },
        { src: "https://example.test/plugin.svg", mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    });

    expect(result.iconUrl).toBe("https://example.test/plugin.svg");
  });
});
