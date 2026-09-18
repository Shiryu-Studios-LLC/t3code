import {
  McpRegistryError,
  type McpRegistryCategory,
  type McpRegistryInstallOption,
  type McpRegistrySearchResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

const OFFICIAL_MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
const REGISTRY_RESULT_LIMIT = 24;

const CATEGORY_RULES: ReadonlyArray<{
  readonly category: McpRegistryCategory;
  readonly keywords: ReadonlyArray<string>;
}> = [
  {
    category: "communication",
    keywords: [
      "discord",
      "slack",
      "telegram",
      "whatsapp",
      "teams",
      "twilio",
      "gmail",
      "outlook",
      "email",
      "mail",
      "sms",
      "messaging",
      "communication",
    ],
  },
  {
    category: "developer-tools",
    keywords: [
      "github",
      "gitlab",
      "bitbucket",
      "git",
      "repository",
      "source control",
      "pull request",
      "code review",
      "developer",
      "coding",
      "ide",
    ],
  },
  {
    category: "productivity",
    keywords: [
      "notion",
      "linear",
      "jira",
      "asana",
      "trello",
      "calendar",
      "todo",
      "task management",
      "project management",
      "productivity",
      "notes",
      "meeting",
      "monday",
    ],
  },
  {
    category: "data-databases",
    keywords: [
      "postgres",
      "postgresql",
      "mysql",
      "sqlite",
      "mongodb",
      "redis",
      "database",
      "sql",
      "snowflake",
      "bigquery",
      "data warehouse",
      "analytics",
      "elasticsearch",
      "supabase",
    ],
  },
  {
    category: "cloud-infrastructure",
    keywords: [
      "aws",
      "amazon web services",
      "azure",
      "gcp",
      "google cloud",
      "cloudflare",
      "kubernetes",
      "docker",
      "terraform",
      "infrastructure",
      "deployment",
      "container",
      "ssh",
    ],
  },
  {
    category: "ai-search",
    keywords: [
      "openai",
      "anthropic",
      "artificial intelligence",
      "llm",
      "web search",
      "search engine",
      "brave search",
      "perplexity",
      "embedding",
      "vector search",
      "rag",
    ],
  },
  {
    category: "files-storage",
    keywords: [
      "google drive",
      "dropbox",
      "onedrive",
      "file system",
      "filesystem",
      "file storage",
      "cloud storage",
      "storage",
      "files",
    ],
  },
  {
    category: "finance",
    keywords: [
      "finance",
      "financial",
      "banking",
      "bank",
      "stocks",
      "investment",
      "accounting",
      "quickbooks",
      "stripe",
      "paypal",
      "payments",
      "crypto",
    ],
  },
  {
    category: "commerce-delivery",
    keywords: [
      "shopify",
      "ecommerce",
      "e commerce",
      "commerce",
      "shopping",
      "delivery",
      "doordash",
      "uber eats",
      "instacart",
      "restaurant",
      "food order",
      "order management",
      "shopping cart",
    ],
  },
  {
    category: "media-entertainment",
    keywords: [
      "spotify",
      "youtube",
      "plex",
      "twitch",
      "music",
      "video",
      "audio",
      "podcast",
      "streaming media",
      "media library",
    ],
  },
  {
    category: "smart-home-iot",
    keywords: [
      "home assistant",
      "homeassistant",
      "philips hue",
      "smart home",
      "iot",
      "mqtt",
      "smart device",
    ],
  },
  {
    category: "travel-maps",
    keywords: [
      "google maps",
      "maps",
      "mapping",
      "travel",
      "flight",
      "hotel",
      "booking",
      "geocoding",
      "directions",
      "transit",
    ],
  },
  {
    category: "utilities",
    keywords: ["weather", "forecast", "calculator", "unit conversion", "timezone", "time zone"],
  },
];

function normalizeCategoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function categoryKeywordMatches(text: string, keyword: string): boolean {
  const normalizedKeyword = normalizeCategoryText(keyword);
  return normalizedKeyword.length > 0 && ` ${text} `.includes(` ${normalizedKeyword} `);
}

export function classifyMcpRegistryServer(
  server: Pick<RegistryServerDetail, "name" | "title" | "description">,
): McpRegistryCategory {
  const identityText = normalizeCategoryText(`${server.name} ${server.title ?? ""}`);
  const allText = normalizeCategoryText(
    `${server.name} ${server.title ?? ""} ${server.description}`,
  );
  let bestCategory: McpRegistryCategory = "other";
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (categoryKeywordMatches(allText, keyword)) score += 1;
      if (categoryKeywordMatches(identityText, keyword)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  return bestCategory;
}

const RegistryInput = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  isRequired: Schema.optionalKey(Schema.Boolean),
  value: Schema.optionalKey(Schema.String),
  isSecret: Schema.optionalKey(Schema.Boolean),
  default: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
});
type RegistryInput = typeof RegistryInput.Type;

const RegistryKeyValueInput = Schema.Struct({
  ...RegistryInput.fields,
  name: Schema.String,
});
type RegistryKeyValueInput = typeof RegistryKeyValueInput.Type;

const RegistryRemoteTransport = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Array(RegistryKeyValueInput)),
});
type RegistryRemoteTransport = typeof RegistryRemoteTransport.Type;

const RegistryPackage = Schema.Struct({
  registryType: Schema.String,
  identifier: Schema.String,
  version: Schema.optionalKey(Schema.String),
  runtimeHint: Schema.optionalKey(Schema.String),
  transport: Schema.Struct({ type: Schema.String }),
  runtimeArguments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  packageArguments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  environmentVariables: Schema.optionalKey(Schema.Array(RegistryKeyValueInput)),
});
type RegistryPackage = typeof RegistryPackage.Type;

const RegistryIcon = Schema.Struct({
  src: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  sizes: Schema.optionalKey(Schema.Array(Schema.String)),
  theme: Schema.optionalKey(Schema.String),
});
type RegistryIcon = typeof RegistryIcon.Type;

const RegistryServerDetail = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.String,
  version: Schema.String,
  icons: Schema.optionalKey(Schema.Array(RegistryIcon)),
  websiteUrl: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String,
      source: Schema.String,
    }),
  ),
  remotes: Schema.optionalKey(Schema.Array(RegistryRemoteTransport)),
  packages: Schema.optionalKey(Schema.Array(RegistryPackage)),
});
type RegistryServerDetail = typeof RegistryServerDetail.Type;

const RegistrySearchDocument = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      server: RegistryServerDetail,
    }),
  ),
});

function containsTemplate(value: string): boolean {
  return /\{[^}]+\}/.test(value);
}

function configuredValue(input: RegistryInput): string | undefined {
  const value = input.value ?? input.default;
  if (value === undefined || containsTemplate(value)) return undefined;
  return value;
}

function remoteInstall(
  remote: RegistryRemoteTransport,
  index: number,
): McpRegistryInstallOption | null {
  if (
    (remote.type !== "streamable-http" && remote.type !== "sse") ||
    !/^https?:\/\//i.test(remote.url) ||
    containsTemplate(remote.url)
  ) {
    return null;
  }

  let requiresConfiguration = false;
  const headers = (remote.headers ?? []).flatMap((header) => {
    const value = configuredValue(header);
    if (value !== undefined) return [{ name: header.name, value }];
    if (header.isRequired === true) {
      requiresConfiguration = true;
      return [{ name: header.name, value: "" }];
    }
    return [];
  });

  return {
    id: `remote-${index}`,
    label: remote.type === "sse" ? "Remote SSE" : "Remote HTTP",
    source: "remote",
    requiresConfiguration,
    transport: {
      type: "http",
      url: remote.url,
      headers,
    },
  };
}

function npmInstall(pkg: RegistryPackage, index: number): McpRegistryInstallOption | null {
  if (
    pkg.registryType !== "npm" ||
    pkg.transport.type !== "stdio" ||
    (pkg.runtimeHint !== undefined && pkg.runtimeHint !== "npx") ||
    (pkg.runtimeArguments?.length ?? 0) > 0 ||
    (pkg.packageArguments?.length ?? 0) > 0
  ) {
    return null;
  }

  let requiresConfiguration = false;
  const environment = (pkg.environmentVariables ?? []).flatMap((variable) => {
    const value = configuredValue(variable);
    if (value !== undefined) return [{ name: variable.name, value }];
    if (variable.isRequired === true) {
      requiresConfiguration = true;
      return [{ name: variable.name, value: "" }];
    }
    return [];
  });
  const packageRef = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;

  return {
    id: `npm-${index}`,
    label: "Local npm",
    source: "npm",
    requiresConfiguration,
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", packageRef],
      environment,
    },
  };
}

function registryIconUrl(icons: ReadonlyArray<RegistryIcon> | undefined): string | undefined {
  if (!icons) return undefined;
  const supportedMimeTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/svg+xml",
  ]);
  for (const icon of icons) {
    try {
      const url = new URL(icon.src);
      if (url.protocol !== "https:") continue;
      if (icon.mimeType && !supportedMimeTypes.has(icon.mimeType.toLowerCase())) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

export function summarizeRegistryServer(server: RegistryServerDetail) {
  const installs: McpRegistryInstallOption[] = [];
  for (const [index, remote] of (server.remotes ?? []).entries()) {
    const install = remoteInstall(remote, index);
    if (install) installs.push(install);
  }
  for (const [index, pkg] of (server.packages ?? []).entries()) {
    const install = npmInstall(pkg, index);
    if (install) installs.push(install);
  }

  const fallbackTitle = server.name.split("/").at(-1) || server.name;
  const iconUrl = registryIconUrl(server.icons);
  return {
    name: server.name,
    title: server.title?.trim() || fallbackTitle,
    description: server.description,
    version: server.version,
    category: classifyMcpRegistryServer(server),
    ...(iconUrl ? { iconUrl } : {}),
    ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
    ...(server.repository?.url ? { repositoryUrl: server.repository.url } : {}),
    installs,
  };
}

export const decodeRegistrySearchDocument = Schema.decodeUnknownEffect(RegistrySearchDocument);

export const searchOfficialMcpRegistry = Effect.fn("McpRegistry.searchOfficialMcpRegistry")(
  function* (query: string) {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(OFFICIAL_MCP_REGISTRY_URL);
    url.searchParams.set("limit", String(REGISTRY_RESULT_LIMIT));
    url.searchParams.set("version", "latest");
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 0) url.searchParams.set("search", normalizedQuery.slice(0, 200));

    const document = yield* client.get(url.toString()).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(15_000),
    );
    const decoded = yield* decodeRegistrySearchDocument(document);
    return {
      servers: decoded.servers.map(({ server }) => summarizeRegistryServer(server)),
    } satisfies McpRegistrySearchResult;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning(`Official MCP Registry search failed: ${Cause.pretty(cause)}`).pipe(
      Effect.andThen(
        Effect.fail(
          new McpRegistryError({
            message: "The official MCP Registry is unavailable right now. Try again shortly.",
          }),
        ),
      ),
    ),
  ),
);
