import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { searchOfficialMcpRegistry } from "../../McpRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ExtensionManagementError, ExtensionManagementToolkit } from "./tools.ts";

function normalizedReference(value: string): string {
  return value.trim().toLowerCase();
}

const readSettings = Effect.fn("ExtensionManagement.readSettings")(function* () {
  yield* McpInvocationContext.McpInvocationContext;
  const settings = yield* ServerSettingsService;
  return yield* settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new ExtensionManagementError({
          message: "T3 Studio could not read extension settings.",
        }),
    ),
  );
});

const updateSettings = Effect.fn("ExtensionManagement.updateSettings")(function* (
  patch: Parameters<ServerSettingsService["Service"]["updateSettings"]>[0],
) {
  yield* McpInvocationContext.McpInvocationContext;
  const settings = yield* ServerSettingsService;
  return yield* settings.updateSettings(patch).pipe(
    Effect.mapError(
      () =>
        new ExtensionManagementError({
          message: "T3 Studio could not save extension settings.",
        }),
    ),
  );
});

const handlers = {
  t3_plugin_catalog_search: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.McpInvocationContext;
      const result = yield* searchOfficialMcpRegistry(input.query).pipe(
        Effect.mapError(
          (error) =>
            new ExtensionManagementError({
              message: error.message,
            }),
        ),
      );
      return input.category === undefined
        ? result
        : { servers: result.servers.filter((server) => server.category === input.category) };
    }),

  t3_plugin_list_installed: () =>
    readSettings().pipe(
      Effect.map((settings) => ({
        plugins: settings.mcpServers.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          enabled: plugin.enabled,
          transport: plugin.transport.type,
        })),
      })),
    ),

  t3_plugin_set_enabled: (input) =>
    Effect.gen(function* () {
      const current = yield* readSettings();
      const reference = normalizedReference(input.plugin);
      const exactId = current.mcpServers.find((plugin) => plugin.id === input.plugin.trim());
      const nameMatches = current.mcpServers.filter(
        (plugin) => normalizedReference(plugin.name) === reference,
      );
      const plugin = exactId ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);

      if (!plugin) {
        const detail =
          nameMatches.length > 1
            ? "More than one installed plugin has that name; use the plugin id instead."
            : "No installed plugin matched that id or name.";
        return yield* new ExtensionManagementError({ message: detail });
      }

      if (plugin.enabled !== input.enabled) {
        yield* updateSettings({
          mcpServers: current.mcpServers.map((candidate) =>
            candidate.id === plugin.id ? { ...candidate, enabled: input.enabled } : candidate,
          ),
        });
      }

      return {
        id: plugin.id,
        name: plugin.name,
        enabled: input.enabled,
        transport: plugin.transport.type,
        sessionRefreshRecommended: true,
      };
    }),

  t3_skill_list: () =>
    readSettings().pipe(
      Effect.map((settings) => ({
        skills: settings.t3Skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          displayName: skill.displayName,
          ...(skill.description ? { description: skill.description } : {}),
          enabled: skill.enabled,
        })),
      })),
    ),

  t3_skill_set_enabled: (input) =>
    Effect.gen(function* () {
      const current = yield* readSettings();
      const reference = normalizedReference(input.skill);
      const exactId = current.t3Skills.find((skill) => skill.id === input.skill.trim());
      const nameMatches = current.t3Skills.filter(
        (skill) =>
          normalizedReference(skill.name) === reference ||
          normalizedReference(skill.displayName) === reference,
      );
      const skill = exactId ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);

      if (!skill) {
        const detail =
          nameMatches.length > 1
            ? "More than one T3 Skill matched that name; use the skill id instead."
            : "No T3 Skill matched that id or name.";
        return yield* new ExtensionManagementError({ message: detail });
      }

      if (skill.enabled !== input.enabled) {
        yield* updateSettings({
          t3Skills: current.t3Skills.map((candidate) =>
            candidate.id === skill.id ? { ...candidate, enabled: input.enabled } : candidate,
          ),
        });
      }

      return {
        id: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        enabled: input.enabled,
      };
    }),
} satisfies Parameters<typeof ExtensionManagementToolkit.toLayer>[0];

export const ExtensionManagementToolkitHandlersLive = ExtensionManagementToolkit.toLayer(handlers);
