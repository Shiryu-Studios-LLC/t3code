import * as Schema from "effect/Schema";

/** Actual renderer inputs, persisted with the attachment across all clients. */
export const ImageGenerationDetails = Schema.Struct({
  checkpoint: Schema.String,
  profile: Schema.String,
  baseModel: Schema.String,
  engine: Schema.String,
  sampler: Schema.String,
  scheduler: Schema.String,
  steps: Schema.Number,
  guidance: Schema.Number,
  seed: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  positivePrompt: Schema.String,
  negativePrompt: Schema.String,
  denoise: Schema.Number,
  referenceAttachmentId: Schema.optional(Schema.String),
  character: Schema.optional(Schema.String),
  sceneMode: Schema.optional(Schema.String),
  modelProfile: Schema.optional(Schema.String),
  policyVersion: Schema.optional(Schema.String),
  referenceState: Schema.optional(Schema.String),
  formatterModel: Schema.optional(Schema.String),
  formatterFallback: Schema.optional(Schema.Boolean),
  promptSource: Schema.optional(Schema.String),
  checkpointHash: Schema.optional(Schema.String),
  loras: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, weight: Schema.Number }),
  ),
});
export type ImageGenerationDetails = typeof ImageGenerationDetails.Type;
