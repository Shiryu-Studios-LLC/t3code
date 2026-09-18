import type {
  McpRegistryCategory,
  McpRegistryInstallOption,
  McpRegistryServer,
  McpServerConfig,
  McpServerTransport,
} from "@t3tools/contracts";

export const MCP_REGISTRY_CATEGORY_PRESENTATION: ReadonlyArray<{
  readonly category: McpRegistryCategory;
  readonly label: string;
  readonly description: string;
}> = [
  {
    category: "communication",
    label: "Communication",
    description: "Chat, email, messaging, and team communication.",
  },
  {
    category: "developer-tools",
    label: "Developer Tools",
    description: "Code, repositories, reviews, and development workflows.",
  },
  {
    category: "productivity",
    label: "Productivity",
    description: "Tasks, notes, calendars, projects, and collaboration.",
  },
  {
    category: "data-databases",
    label: "Data & Databases",
    description: "Databases, analytics, warehouses, and data tools.",
  },
  {
    category: "cloud-infrastructure",
    label: "Cloud & Infrastructure",
    description: "Cloud platforms, deployment, containers, and infrastructure.",
  },
  {
    category: "ai-search",
    label: "AI & Search",
    description: "AI services, search engines, retrieval, and knowledge tools.",
  },
  {
    category: "files-storage",
    label: "Files & Storage",
    description: "File systems, drives, storage, and document access.",
  },
  {
    category: "commerce-delivery",
    label: "Shopping & Delivery",
    description: "Commerce, restaurants, shopping, ordering, and delivery.",
  },
  {
    category: "finance",
    label: "Finance",
    description: "Banking, accounting, payments, markets, and financial tools.",
  },
  {
    category: "media-entertainment",
    label: "Media & Entertainment",
    description: "Music, video, streaming, podcasts, and media libraries.",
  },
  {
    category: "smart-home-iot",
    label: "Smart Home & IoT",
    description: "Home automation, smart devices, and IoT systems.",
  },
  {
    category: "travel-maps",
    label: "Travel & Maps",
    description: "Maps, travel, directions, flights, hotels, and transit.",
  },
  {
    category: "utilities",
    label: "Utilities",
    description: "Weather, conversions, time, and general-purpose utilities.",
  },
  {
    category: "other",
    label: "Other",
    description: "Plugins that do not fit another section yet.",
  },
];

export interface McpRegistryCategoryGroup {
  readonly category: McpRegistryCategory;
  readonly label: string;
  readonly description: string;
  readonly servers: ReadonlyArray<McpRegistryServer>;
}

export function groupMcpRegistryServersByCategory(
  servers: ReadonlyArray<McpRegistryServer>,
): McpRegistryCategoryGroup[] {
  const byCategory = new Map<McpRegistryCategory, McpRegistryServer[]>();
  for (const server of servers) {
    const list = byCategory.get(server.category) ?? [];
    list.push(server);
    byCategory.set(server.category, list);
  }

  return MCP_REGISTRY_CATEGORY_PRESENTATION.flatMap((presentation) => {
    const grouped = byCategory.get(presentation.category);
    if (!grouped || grouped.length === 0) return [];
    return [
      {
        ...presentation,
        servers: grouped.toSorted((left, right) => left.title.localeCompare(right.title)),
      },
    ];
  });
}

function normalizedHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function sameTransport(left: McpServerTransport, right: McpServerTransport): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "http" && right.type === "http") {
    return normalizedHttpUrl(left.url) === normalizedHttpUrl(right.url);
  }
  if (left.type === "stdio" && right.type === "stdio") {
    return (
      left.command === right.command &&
      left.args.length === right.args.length &&
      left.args.every((arg, index) => arg === right.args[index])
    );
  }
  return false;
}

export function isMcpRegistryInstallConfigured(
  servers: ReadonlyArray<McpServerConfig>,
  install: McpRegistryInstallOption,
): boolean {
  return servers.some((server) => sameTransport(server.transport, install.transport));
}

function pluginIdBase(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `plugin-${slug || "mcp"}`;
}

export function makeMcpRegistryServerConfig(
  server: McpRegistryServer,
  install: McpRegistryInstallOption,
  existing: ReadonlyArray<McpServerConfig>,
): McpServerConfig {
  const base = pluginIdBase(server.name);
  let id = base;
  let suffix = 2;
  while (existing.some((candidate) => candidate.id === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  return {
    id,
    name: server.title,
    enabled: true,
    transport: install.transport,
  };
}
