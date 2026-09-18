import {
  type ModelCapabilities,
  type OllamaSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const OLLAMA_PRESENTATION = {
  displayName: "Ollama",
  showInteractionModeToggle: true,
} as const;

export const DEFAULT_OLLAMA_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const OllamaTagsResponse = Schema.Struct({
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        model: Schema.optional(Schema.String),
      }),
    ),
  ),
});

export function resolveOllamaEndpoint(settings: OllamaSettings): string {
  return (settings.endpoint?.trim() || "http://127.0.0.1:11434").replace(/\/+$/u, "");
}

function displayName(slug: string): string {
  return slug
    .split(":", 1)[0]!
    .split(/[-_/]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const probeOllama = Effect.fn("probeOllama")(function* (settings: OllamaSettings) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${resolveOllamaEndpoint(settings)}/api/tags`);
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.timeout("3 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaTagsResponse)),
    );
  const models = (response.models ?? []).map(
    (item): ServerProviderModel => ({
      slug: item.name,
      name: displayName(item.name),
      isCustom: false,
      capabilities: DEFAULT_OLLAMA_MODEL_CAPABILITIES,
    }),
  );
  return { reachable: true as const, models };
});

export const fetchOllamaModels = Effect.fn("fetchOllamaModels")(function* (
  settings: OllamaSettings,
) {
  const result = yield* probeOllama(settings);
  return result.models;
});

export const buildInitialOllamaProviderSnapshot = Effect.fn("buildInitialOllamaProviderSnapshot")(
  function* (settings: OllamaSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: OLLAMA_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        DEFAULT_OLLAMA_MODEL_CAPABILITIES,
      ),
      probe: settings.enabled
        ? {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking local Ollama server...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Ollama is disabled in T3 Studio settings.",
          },
    });
  },
);

export const checkOllamaProviderStatus = Effect.fn("checkOllamaProviderStatus")(function* (
  settings: OllamaSettings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* buildInitialOllamaProviderSnapshot(settings);

  const probe = yield* probeOllama(settings).pipe(
    Effect.orElseSucceed(() => ({
      reachable: false as const,
      models: [] as ReadonlyArray<ServerProviderModel>,
    })),
  );
  const models = providerModelsFromSettings(
    probe.models,
    settings.customModels,
    DEFAULT_OLLAMA_MODEL_CAPABILITIES,
  );
  const modelCount = probe.models.length;

  return buildServerProvider({
    presentation: OLLAMA_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: probe.reachable,
      version: null,
      status: probe.reachable && modelCount > 0 ? "ready" : "warning",
      auth: { status: probe.reachable ? "authenticated" : "unknown" },
      message: !probe.reachable
        ? `No Ollama server responded at ${resolveOllamaEndpoint(settings)}. T3 will start the default local server automatically when the Ollama binary is available.`
        : modelCount === 0
          ? `Ollama is running at ${resolveOllamaEndpoint(settings)}, but no local models are installed yet. Pull a model such as qwen3:8b to start chatting.`
          : `Ollama is ready at ${resolveOllamaEndpoint(settings)} with ${modelCount} local model${modelCount === 1 ? "" : "s"}.`,
    },
  });
});
