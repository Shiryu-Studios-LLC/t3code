import { McpRegistryCategory, McpRegistrySearchResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

export class ExtensionManagementError extends Schema.TaggedErrorClass<ExtensionManagementError>()(
  "ExtensionManagementError",
  { message: Schema.String },
) {}

const PluginReferenceInput = Schema.Struct({
  plugin: Schema.String.annotate({
    description: "Installed plugin id or exact plugin display name.",
  }),
  enabled: Schema.Boolean,
});

const SkillReferenceInput = Schema.Struct({
  skill: Schema.String.annotate({
    description: "T3 Skill id, skill name, or exact display name.",
  }),
  enabled: Schema.Boolean,
});

const PluginSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  transport: Schema.Literals(["http", "stdio"]),
});

const InstalledPluginsResult = Schema.Struct({
  plugins: Schema.Array(PluginSummary),
});

const PluginToggleResult = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  transport: Schema.Literals(["http", "stdio"]),
  sessionRefreshRecommended: Schema.Boolean,
});

const SkillSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
});

const SkillsResult = Schema.Struct({
  skills: Schema.Array(SkillSummary),
});

const SkillToggleResult = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
});

const authenticatedDependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService,
];

export const PluginCatalogSearchTool = Tool.make("t3_plugin_catalog_search", {
  description:
    "Search T3 Studio's official MCP plugin catalog. Use this when the user asks whether a plugin exists for a capability or when installed plugins do not already satisfy the request. Returns categorized plugin candidates and compatible install options. This only searches; it does not install anything.",
  parameters: Schema.Struct({
    query: Schema.String,
    category: Schema.optionalKey(McpRegistryCategory),
  }),
  success: McpRegistrySearchResult,
  failure: ExtensionManagementError,
  dependencies: [...authenticatedDependencies, HttpClient.HttpClient],
})
  .annotate(Tool.Title, "Search T3 plugin catalog")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const InstalledPluginsTool = Tool.make("t3_plugin_list_installed", {
  description:
    "List plugins already installed in this T3 Studio environment, including their ids, enabled state, and transport type. Use this first when the user asks what plugins/capabilities are installed, available, enabled, or could be enabled.",
  parameters: Schema.Struct({}),
  success: InstalledPluginsResult,
  failure: ExtensionManagementError,
  dependencies: authenticatedDependencies,
})
  .annotate(Tool.Title, "List installed T3 plugins")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PluginSetEnabledTool = Tool.make("t3_plugin_set_enabled", {
  description:
    "Enable or disable a plugin that is already installed in T3 Studio. This never installs a new third-party plugin. Enabling may require a new provider session before its tools appear.",
  parameters: PluginReferenceInput,
  success: PluginToggleResult,
  failure: ExtensionManagementError,
  dependencies: authenticatedDependencies,
})
  .annotate(Tool.Title, "Enable or disable installed plugin")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const SkillsListTool = Tool.make("t3_skill_list", {
  description:
    "List T3 Studio environment-owned skills and whether each reusable workflow is enabled.",
  parameters: Schema.Struct({}),
  success: SkillsResult,
  failure: ExtensionManagementError,
  dependencies: authenticatedDependencies,
})
  .annotate(Tool.Title, "List T3 Skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SkillSetEnabledTool = Tool.make("t3_skill_set_enabled", {
  description:
    "Enable or disable an existing T3 Skill by id, skill name, or display name. The change applies to subsequent turns.",
  parameters: SkillReferenceInput,
  success: SkillToggleResult,
  failure: ExtensionManagementError,
  dependencies: authenticatedDependencies,
})
  .annotate(Tool.Title, "Enable or disable T3 Skill")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ExtensionManagementToolkit = Toolkit.make(
  PluginCatalogSearchTool,
  InstalledPluginsTool,
  PluginSetEnabledTool,
  SkillsListTool,
  SkillSetEnabledTool,
);
