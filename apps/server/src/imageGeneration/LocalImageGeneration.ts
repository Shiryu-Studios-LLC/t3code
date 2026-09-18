import {
  LocalImageGenerationError,
  type LocalImageGenerateInput,
  type LocalImageModel,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatImageAttachment,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { generateLocalImage } from "../mcp/toolkits/imageGeneration/handlers.ts";
import { refineImagePromptWithSpecialist } from "./ImageVisionSpecialist.ts";

function localImageError(message: string, cause?: unknown): LocalImageGenerationError {
  const detail =
    cause instanceof Error && cause.message.trim() ? `${message}: ${cause.message}` : message;
  return new LocalImageGenerationError({ message: detail });
}

const MATURE_IMAGE_PATTERN = /\b(?:nsfw|nude|naked|erotic|sensual|sexy|explicit|boudoir)\b/i;
const POKEMON_IMAGE_PATTERN = /\b(?:pokemon|pokémon|pikachu|eevee|charizard|pokédex|pokedex)\b/i;
const FURRY_IMAGE_PATTERN =
  /\b(?:furry|fursona|anthro|anthropomorphic|kitsune|kemono|canine|feline|fox|wolf|dog|cat)\b/i;
const ANIME_IMAGE_PATTERN = /\b(?:anime|manga|waifu|bishoujo|bishonen|cel[- ]?shaded)\b/i;

/** Choose the most suitable installed SDXL checkpoint when the caller does not force one. */
export function inferLocalImageModel(prompt: string): LocalImageModel {
  if (MATURE_IMAGE_PATTERN.test(prompt)) return "nova-mature";
  if (POKEMON_IMAGE_PATTERN.test(prompt)) return "nova-pkm";
  if (FURRY_IMAGE_PATTERN.test(prompt)) return "nova-furry";
  if (ANIME_IMAGE_PATTERN.test(prompt)) return "nova-anime";
  return "nova-unreal";
}

export function resolveLocalImageReferencePath(input: {
  readonly durablePath: string | null;
  readonly fallbackPath: string | null;
  readonly fallbackExists: boolean;
}): string | null {
  return input.durablePath ?? (input.fallbackExists ? input.fallbackPath : null);
}

/** Give the assistant side of a native image turn a stable later sort key. */
export function localImageAssistantCreatedAt(userCreatedAt: string): string {
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(userCreatedAt), { milliseconds: 1 }));
}

/**
 * Run the local SDXL generator and copy the result into T3's durable attachment
 * store. The original generated_images file remains available for Open Folder;
 * the attachment copy is the conversation asset used by every T3 client.
 */
export const generateAndPersistLocalImage = Effect.fn("generateAndPersistLocalImage")(function* (
  input: LocalImageGenerateInput,
  options: { readonly referenceImageFallbackPath?: string | null } = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError((cause) => localImageError("Could not read image generation settings", cause)),
  );
  const durableReferenceImagePath = input.referenceAttachmentId
    ? resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.referenceAttachmentId,
      })
    : null;
  const fallbackReferenceImagePath = options.referenceImageFallbackPath?.trim() || null;
  const fallbackReferenceExists =
    durableReferenceImagePath === null && fallbackReferenceImagePath !== null
      ? yield* fs.exists(fallbackReferenceImagePath).pipe(Effect.orElseSucceed(() => false))
      : false;
  const referenceImagePath = resolveLocalImageReferencePath({
    durablePath: durableReferenceImagePath,
    fallbackPath: fallbackReferenceImagePath,
    fallbackExists: fallbackReferenceExists,
  });

  if (input.referenceAttachmentId && !referenceImagePath) {
    return yield* localImageError("The referenced conversation image is unavailable.");
  }

  const specialist = input.skipPromptRefinement
    ? { prompt: input.prompt.trim(), model: null as string | null }
    : yield* refineImagePromptWithSpecialist({
        prompt: input.prompt,
        ...(referenceImagePath ? { referenceImagePath } : {}),
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Image/vision specialist unavailable; using the original image prompt.",
            {
              cause,
            },
          ).pipe(Effect.as({ prompt: input.prompt.trim(), model: null as string | null })),
        ),
      );

  const imageSettings = settings.imageGeneration;
  const configuredCheckpoint = imageSettings.checkpoint;
  const imageModel =
    input.model ??
    (configuredCheckpoint === "auto" ? inferLocalImageModel(input.prompt) : configuredCheckpoint);
  const requestCheckpointPath = input.checkpointPath?.trim();
  const requestLoras = input.loras?.map((lora) => ({
    name: lora.name.trim() || "Character LoRA",
    path: lora.path.trim(),
    weight: lora.weight,
  }));
  const generated = yield* generateLocalImage({
    prompt: specialist.prompt,
    negativePrompt: input.negativePrompt ?? imageSettings.negativePrompt,
    model: imageModel,
    ...(requestCheckpointPath
      ? { checkpointPath: requestCheckpointPath }
      : imageModel === "custom"
        ? { checkpointPath: imageSettings.customCheckpointPath }
        : {}),
    width: input.width ?? imageSettings.width,
    height: input.height ?? imageSettings.height,
    steps: input.steps ?? imageSettings.steps,
    guidance: input.guidance ?? imageSettings.guidance,
    ...(input.sampler ? { sampler: input.sampler } : {}),
    ...(input.scheduler ? { scheduler: input.scheduler } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    editStrength: imageSettings.editStrength,
    loras:
      requestLoras ??
      imageSettings.loras
        .filter((lora) => lora.enabled && lora.path.trim().length > 0)
        .map((lora) => ({ name: lora.name, path: lora.path, weight: lora.weight })),
    ...(referenceImagePath ? { referenceImagePath } : {}),
  }).pipe(Effect.mapError((cause) => localImageError("Local image generation failed", cause)));

  const bytes = yield* fs
    .readFile(generated.outputPath)
    .pipe(Effect.mapError((cause) => localImageError("Generated image could not be read", cause)));
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return yield* localImageError(
      bytes.byteLength === 0
        ? "The local generator produced an empty image file."
        : `The generated image exceeds T3's ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} byte attachment limit.`,
    );
  }

  const attachmentId = createAttachmentId(input.threadId);
  if (!attachmentId) {
    return yield* localImageError("Could not allocate a conversation image identifier.");
  }

  const attachment: ChatImageAttachment = {
    type: "image",
    id: attachmentId,
    name: `generated-${attachmentId.slice(-12)}.png`,
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
    source: "generated",
    savedPath: generated.outputPath,
    generationPrompt: input.prompt.trim(),
    generationDetails: {
      ...generated.generationDetails,
      ...(input.referenceAttachmentId
        ? { referenceAttachmentId: input.referenceAttachmentId }
        : {}),
      ...(input.shiryuGenMetadata
        ? {
            character: input.shiryuGenMetadata.character,
            sceneMode: input.shiryuGenMetadata.sceneMode,
            modelProfile: input.shiryuGenMetadata.modelProfile,
            policyVersion: input.shiryuGenMetadata.policyVersion,
            referenceState: input.shiryuGenMetadata.referenceState,
            ...(input.shiryuGenMetadata.formatterModel !== undefined
              ? { formatterModel: input.shiryuGenMetadata.formatterModel }
              : {}),
            ...(input.shiryuGenMetadata.formatterFallback !== undefined
              ? { formatterFallback: input.shiryuGenMetadata.formatterFallback }
              : {}),
            ...(input.shiryuGenMetadata.promptSource !== undefined
              ? { promptSource: input.shiryuGenMetadata.promptSource }
              : {}),
          }
        : {}),
    },
    generationTool: specialist.model
      ? `${referenceImagePath ? "local-sdxl-img2img" : "local-sdxl"}+${specialist.model}`
      : referenceImagePath
        ? "local-sdxl-img2img"
        : "local-sdxl",
  };
  const durablePath = resolveAttachmentPath({
    attachmentsDir: config.attachmentsDir,
    attachment,
  });
  if (!durablePath) {
    return yield* localImageError("Could not resolve the conversation attachment path.");
  }

  yield* fs
    .makeDirectory(config.attachmentsDir, { recursive: true })
    .pipe(
      Effect.mapError((cause) => localImageError("Could not prepare the attachment store", cause)),
    );
  yield* fs
    .writeFile(durablePath, bytes)
    .pipe(
      Effect.mapError((cause) =>
        localImageError("Could not persist the generated conversation image", cause),
      ),
    );

  return { attachments: [attachment] };
});
