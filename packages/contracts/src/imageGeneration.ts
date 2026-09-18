import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ChatImageAttachment } from "./orchestration.ts";

export const LocalImageModel = Schema.Literals([
  "nova-unreal",
  "nova-anime",
  "perfect-anima",
  "nova-furry",
  "nova-pkm",
  "nova-mature",
  "custom",
]);
export type LocalImageModel = typeof LocalImageModel.Type;

export const LocalImageLoraOverride = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  weight: Schema.Number,
});
export type LocalImageLoraOverride = typeof LocalImageLoraOverride.Type;

export const ShiryuGenImageGenerationMetadata = Schema.Struct({
  character: Schema.String,
  sceneMode: Schema.String,
  modelProfile: Schema.String,
  policyVersion: Schema.String,
  referenceState: Schema.String,
  formatterModel: Schema.optional(Schema.String),
  formatterFallback: Schema.optional(Schema.Boolean),
  promptSource: Schema.optional(Schema.String),
});
export type ShiryuGenImageGenerationMetadata = typeof ShiryuGenImageGenerationMetadata.Type;

export const ShiryuGenPromptFormatInput = Schema.Struct({
  modelProfile: Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    promptStyle: Schema.Literals(["tag", "hybrid", "natural"]),
  }),
  sceneMode: Schema.String,
  lockedFacts: Schema.Array(Schema.String),
  requiredConcepts: Schema.Array(Schema.String),
  optionalConcepts: Schema.Array(Schema.String),
  forbiddenConcepts: Schema.Array(Schema.String),
  requiredTags: Schema.Array(Schema.String),
  optionalTags: Schema.Array(Schema.String),
  forbiddenTags: Schema.Array(Schema.String),
  userSceneRequest: Schema.String,
  styleRequirements: Schema.Array(Schema.String),
  deterministicPositivePrompt: Schema.String,
  deterministicNegativePrompt: Schema.String,
});
export type ShiryuGenPromptFormatInput = typeof ShiryuGenPromptFormatInput.Type;

export const ShiryuGenPromptFormatResult = Schema.Struct({
  positivePrompt: Schema.String,
  negativePrompt: Schema.String,
  warnings: Schema.Array(Schema.String),
  formatterModel: Schema.optional(Schema.String),
  usedFallback: Schema.Boolean,
});
export type ShiryuGenPromptFormatResult = typeof ShiryuGenPromptFormatResult.Type;

export const LocalImageGenerateInput = Schema.Struct({
  threadId: ThreadId,
  prompt: Schema.String,
  /** Exact text shown in the conversation for this direct request. */
  requestText: Schema.optional(Schema.String),
  /** Character Kit prompts are already fully compiled; skip the optional LLM prompt rewriter. */
  skipPromptRefinement: Schema.optional(Schema.Boolean),
  negativePrompt: Schema.optional(Schema.String),
  model: Schema.optional(LocalImageModel),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  steps: Schema.optional(Schema.Number),
  guidance: Schema.optional(Schema.Number),
  sampler: Schema.optional(Schema.String),
  scheduler: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.Number),
  /** Reuse a prior generated image as an img2img reference when present. */
  referenceAttachmentId: Schema.optional(Schema.String),
  /** Per-request checkpoint override, used by Character Kit model associations. */
  checkpointPath: Schema.optional(Schema.String),
  /** Per-request LoRA stack. When present it replaces the global generation LoRA list. */
  loras: Schema.optional(Schema.Array(LocalImageLoraOverride)),
  /** Character-policy metadata persisted with generated images for diagnostics. */
  shiryuGenMetadata: Schema.optional(ShiryuGenImageGenerationMetadata),
});
export type LocalImageGenerateInput = typeof LocalImageGenerateInput.Type;

export const LocalImageGenerateResult = Schema.Struct({
  attachments: Schema.Array(ChatImageAttachment),
});
export type LocalImageGenerateResult = typeof LocalImageGenerateResult.Type;

export class LocalImageGenerationError extends Schema.TaggedErrorClass<LocalImageGenerationError>()(
  "LocalImageGenerationError",
  { message: Schema.String },
) {}
