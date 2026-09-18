import { OllamaSettings, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveOllamaEndpoint } from "../provider/Layers/OllamaProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const OllamaChatResponse = Schema.Struct({
  message: Schema.Struct({
    content: Schema.String,
  }),
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

const decodeOllamaSettings = Schema.decodeUnknownEffect(OllamaSettings);

export class ImageVisionSpecialistError extends Schema.TaggedErrorClass<ImageVisionSpecialistError>()(
  "ImageVisionSpecialistError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
}

function resolveConfiguredOllamaSettings(settings: ServerSettings) {
  const selection = settings.specialistModels.imageVision;
  const configured = settings.providerInstances[selection.instanceId];
  if (configured && configured.driver !== "ollama") {
    return Effect.fail(
      new ImageVisionSpecialistError({
        detail: `The image/vision specialist currently requires an Ollama instance; '${selection.instanceId}' uses '${configured.driver}'.`,
      }),
    );
  }
  return decodeOllamaSettings(configured?.config ?? {});
}

/**
 * Uses the independently configured image/vision specialist to turn a user
 * request into a compact SDXL prompt. This never changes the model/provider
 * attached to the conversation. If Ollama is unavailable, callers should
 * fall back to the original prompt so local rendering remains provider-free.
 */
export const refineImagePromptWithSpecialist = Effect.fn("refineImagePromptWithSpecialist")(
  function* (input: { readonly prompt: string; readonly referenceImagePath?: string }) {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const selection = settings.specialistModels.imageVision;
    const ollamaSettings = yield* resolveConfiguredOllamaSettings(settings);
    const client = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const root = resolveOllamaEndpoint(ollamaSettings);

    const tags = yield* client
      .execute(HttpClientRequest.get(`${root}/api/tags`))
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaTagsResponse)),
      );
    const modelInstalled = (tags.models ?? []).some(
      (candidate) => candidate.name === selection.model || candidate.model === selection.model,
    );
    if (!modelInstalled) {
      yield* Effect.logInfo("Pulling missing Ollama image/vision specialist model.", {
        model: selection.model,
      });
      yield* client
        .execute(
          HttpClientRequest.post(`${root}/api/pull`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ name: selection.model, stream: false }),
          ),
        )
        .pipe(
          Effect.timeout("30 minutes"),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.asVoid,
        );
    }

    const images = input.referenceImagePath
      ? [Buffer.from(yield* fs.readFile(input.referenceImagePath)).toString("base64")]
      : undefined;
    const system = input.referenceImagePath
      ? "You are T3 Studio's fast image-editing prompt specialist. Inspect the supplied image and convert the user's edit request into one concise, production-ready SDXL img2img prompt. Preserve the subject identity, pose, composition, camera angle, and unaffected details unless the user explicitly asks to change them. Include the requested changes clearly. Return only the final prompt, with no markdown, explanation, or analysis."
      : "You are T3 Studio's fast image-generation prompt specialist. Convert the user's request into one concise, production-ready SDXL prompt. Preserve every requested subject, attribute, style, composition, and constraint. Add useful visual detail without changing the intent. Return only the final prompt, with no markdown, explanation, or analysis.";

    const request = HttpClientRequest.post(`${root}/api/chat`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: selection.model,
        stream: false,
        keep_alive: "10m",
        options: {
          temperature: 0.2,
          num_predict: 220,
        },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: input.prompt.trim(),
            ...(images ? { images } : {}),
          },
        ],
      }),
    );

    const response = yield* client
      .execute(request)
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaChatResponse)),
      );
    const refined = stripThinking(response.message.content);
    if (!refined) {
      return yield* new ImageVisionSpecialistError({
        detail: "The image/vision specialist returned an empty prompt.",
      });
    }
    return { prompt: refined, model: selection.model };
  },
);
