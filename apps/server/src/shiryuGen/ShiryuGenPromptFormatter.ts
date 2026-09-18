import {
  OllamaSettings,
  type ServerSettings,
  type ShiryuGenPromptFormatInput,
  type ShiryuGenPromptFormatResult,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveOllamaEndpoint } from "../provider/Layers/OllamaProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";

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

const OllamaChatResponse = Schema.Struct({
  message: Schema.Struct({ content: Schema.String }),
});

const FormattedPromptSchema = Schema.Struct({
  positivePrompt: Schema.String,
  negativePrompt: Schema.String,
  warnings: Schema.Array(Schema.String),
});

const decodeOllamaSettings = Schema.decodeUnknownEffect(OllamaSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export class ShiryuGenPromptFormatterError extends Schema.TaggedErrorClass<ShiryuGenPromptFormatterError>()(
  "ShiryuGenPromptFormatterError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function stripThinking(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
}

function resolveConfiguredOllamaSettings(settings: ServerSettings) {
  const selection = settings.specialistModels.imageVision;
  const configured = settings.providerInstances[selection.instanceId];
  if (configured && configured.driver !== "ollama") {
    return Effect.fail(
      new ShiryuGenPromptFormatterError({
        detail: `The ShiryuGen prompt formatter requires an Ollama instance; '${selection.instanceId}' uses '${configured.driver}'.`,
      }),
    );
  }
  return decodeOllamaSettings(configured?.config ?? {}).pipe(
    Effect.mapError(
      () =>
        new ShiryuGenPromptFormatterError({
          detail: "The configured Ollama settings are invalid.",
        }),
    ),
  );
}

function chooseFormatterModel(
  installed: readonly string[],
  configuredModel: string,
): string | null {
  const normalizedConfigured = configuredModel.trim();
  if (normalizedConfigured && installed.includes(normalizedConfigured)) return normalizedConfigured;
  const preferredPatterns = [/^qwen3(?::|$)/i, /^qwen2\.5(?::|$)/i, /^gemma3(?::|$)/i, /^llama3/i];
  for (const pattern of preferredPatterns) {
    const match = installed.find((candidate) => pattern.test(candidate));
    if (match) return match;
  }
  return installed[0] ?? null;
}

function formatterSystemPrompt(): string {
  return [
    "You are ShiryuGen's local image-prompt formatter. You are NOT a canon writer or policy engine.",
    "The supplied required/forbidden lists are authoritative and were produced by deterministic application code.",
    "Return only one JSON object with keys positivePrompt, negativePrompt, warnings.",
    "Do not invent traits, powers, accessories, lore, or characters.",
    "Do not change the character name, presentation, species, age, life stage, classification, outfit identity, required accessories, power state, or canon constraints.",
    "Preserve EVERY required tag and required concept in the positive prompt. Keep their wording recognizable enough for deterministic validation.",
    "NEVER place a forbidden tag or forbidden concept in the positive prompt.",
    "Put relevant forbidden visual concepts into the negative prompt.",
    "Remove duplicate wording and convert safe prose into checkpoint-appropriate prompt language.",
    "Keep the prompt concise for the target image model. Tag style means comma-separated image-model tags; hybrid may mix tags and short visual phrases; natural uses concise natural visual prose.",
    "The deterministic prompts are safe fallbacks and should be treated as the canonical starting point, not rewritten into new facts.",
  ].join("\n");
}

export const formatShiryuGenPromptWithLocalModel = Effect.fn("formatShiryuGenPromptWithLocalModel")(
  function* (
    input: ShiryuGenPromptFormatInput,
  ): Effect.fn.Return<
    ShiryuGenPromptFormatResult,
    ShiryuGenPromptFormatterError,
    ServerSettingsService | HttpClient.HttpClient
  > {
    if (input.sceneMode === "first-canon-reference") {
      return {
        positivePrompt: input.deterministicPositivePrompt,
        negativePrompt: input.deterministicNegativePrompt,
        warnings: [],
        formatterModel: "deterministic canon compiler",
        usedFallback: false,
      };
    }
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new ShiryuGenPromptFormatterError({
            detail: "ShiryuGen could not read the current server settings.",
          }),
      ),
    );
    const ollamaSettings = yield* resolveConfiguredOllamaSettings(settings);
    const client = yield* HttpClient.HttpClient;
    const root = resolveOllamaEndpoint(ollamaSettings);
    const tags = yield* client.execute(HttpClientRequest.get(`${root}/api/tags`)).pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaTagsResponse)),
      Effect.mapError(
        () =>
          new ShiryuGenPromptFormatterError({
            detail: `Ollama is unavailable at ${root}.`,
          }),
      ),
    );
    const installed = (tags.models ?? []).flatMap((candidate) =>
      [candidate.name, candidate.model].filter((name): name is string => Boolean(name?.trim())),
    );
    const model = chooseFormatterModel(installed, settings.specialistModels.imageVision.model);
    if (!model) {
      return yield* new ShiryuGenPromptFormatterError({
        detail: "Ollama is reachable but no local text model is installed.",
      });
    }

    const request = HttpClientRequest.post(`${root}/api/chat`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model,
        stream: false,
        keep_alive: "10m",
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 1100,
        },
        messages: [
          { role: "system", content: formatterSystemPrompt() },
          {
            role: "user",
            content: encodeUnknownJson({
              targetModelProfile: input.modelProfile,
              sceneMode: input.sceneMode,
              lockedFacts: input.lockedFacts,
              requiredTags: input.requiredTags,
              requiredConcepts: input.requiredConcepts,
              optionalTags: input.optionalTags,
              optionalConcepts: input.optionalConcepts,
              forbiddenTags: input.forbiddenTags,
              forbiddenConcepts: input.forbiddenConcepts,
              userSceneRequest: input.userSceneRequest,
              styleRequirements: input.styleRequirements,
              deterministicPositivePrompt: input.deterministicPositivePrompt,
              deterministicNegativePrompt: input.deterministicNegativePrompt,
            }),
          },
        ],
      }),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaChatResponse)),
      Effect.mapError(
        () =>
          new ShiryuGenPromptFormatterError({
            detail: `Ollama prompt formatting failed for '${model}'.`,
          }),
      ),
    );
    const raw = stripThinking(response.message.content);
    if (!raw) {
      return yield* new ShiryuGenPromptFormatterError({
        detail: "The local prompt formatter returned no structured output.",
      });
    }
    const formatted = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(FormattedPromptSchema),
    )(extractJsonObject(raw)).pipe(
      Effect.mapError(
        () =>
          new ShiryuGenPromptFormatterError({
            detail: "The local prompt formatter returned invalid structured output.",
          }),
      ),
    );
    return {
      positivePrompt: formatted.positivePrompt.trim(),
      negativePrompt: formatted.negativePrompt.trim(),
      warnings: formatted.warnings.map((warning) => warning.trim()).filter(Boolean),
      formatterModel: model,
      usedFallback: false,
    };
  },
);
