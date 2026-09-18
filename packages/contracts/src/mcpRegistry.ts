import * as Schema from "effect/Schema";

import { McpServerTransport } from "./settings.ts";

export const McpRegistryCategory = Schema.Literals([
  "communication",
  "developer-tools",
  "productivity",
  "data-databases",
  "cloud-infrastructure",
  "ai-search",
  "files-storage",
  "commerce-delivery",
  "finance",
  "media-entertainment",
  "smart-home-iot",
  "travel-maps",
  "utilities",
  "other",
]);
export type McpRegistryCategory = typeof McpRegistryCategory.Type;

export const McpRegistryInstallOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  source: Schema.Union([Schema.Literal("remote"), Schema.Literal("npm")]),
  transport: McpServerTransport,
  requiresConfiguration: Schema.Boolean,
});
export type McpRegistryInstallOption = typeof McpRegistryInstallOption.Type;

export const McpRegistryServer = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  version: Schema.String,
  category: McpRegistryCategory,
  iconUrl: Schema.optionalKey(Schema.String),
  websiteUrl: Schema.optionalKey(Schema.String),
  repositoryUrl: Schema.optionalKey(Schema.String),
  installs: Schema.Array(McpRegistryInstallOption),
});
export type McpRegistryServer = typeof McpRegistryServer.Type;

export const McpRegistrySearchInput = Schema.Struct({
  query: Schema.String,
});
export type McpRegistrySearchInput = typeof McpRegistrySearchInput.Type;

export const McpRegistrySearchResult = Schema.Struct({
  servers: Schema.Array(McpRegistryServer),
});
export type McpRegistrySearchResult = typeof McpRegistrySearchResult.Type;

export class McpRegistryError extends Schema.TaggedErrorClass<McpRegistryError>()(
  "McpRegistryError",
  {
    message: Schema.String,
  },
) {}
