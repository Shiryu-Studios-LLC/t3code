import { ImageGenerationDetails } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

export class ImageGenerationError extends Schema.TaggedErrorClass<ImageGenerationError>()(
  "ImageGenerationError",
  { message: Schema.String },
) {}

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

export const GenerateImageResult = Schema.Struct({
  outputPath: Schema.String,
  generationDetails: Schema.optional(ImageGenerationDetails),
  model: LocalImageModel,
  width: Schema.Number,
  height: Schema.Number,
  steps: Schema.Number,
  guidance: Schema.Number,
  seed: Schema.Number,
  elapsedMs: Schema.Number,
});
export type GenerateImageResult = typeof GenerateImageResult.Type;

export const GenerateImageTool = Tool.make("t3_generate_image", {
  description:
    "Generate a high-quality image locally on the T3 Studio host. This is a provider-independent, free/offline image tool backed by the user's local SDXL checkpoints and NVIDIA GPU. Use it whenever the user asks to create, draw, render, design, or generate an image. The default model is Nova Unreal. No cloud image API or API key is required.",
  parameters: Schema.Struct({
    prompt: Schema.String.annotate({
      description: "Detailed positive prompt describing the image to generate.",
    }),
    negativePrompt: Schema.optionalKey(
      Schema.String.annotate({
        description: "Optional things to avoid in the generated image.",
      }),
    ),
    model: Schema.optionalKey(
      LocalImageModel.annotate({
        description:
          "Optional local checkpoint. nova-unreal is the general high-quality default; nova-anime is the preferred anime/character checkpoint; perfect-anima is an alternate illustration/anime checkpoint; the remaining Nova checkpoints are specialized alternatives. custom uses the checkpoint path configured in T3 Settings.",
      }),
    ),
    width: Schema.optionalKey(
      Schema.Number.annotate({ description: "Image width in pixels. 256-1024, multiple of 64." }),
    ),
    height: Schema.optionalKey(
      Schema.Number.annotate({ description: "Image height in pixels. 256-1024, multiple of 64." }),
    ),
    steps: Schema.optionalKey(
      Schema.Number.annotate({ description: "Inference steps. 4-40; defaults to T3 Settings." }),
    ),
    guidance: Schema.optionalKey(
      Schema.Number.annotate({
        description: "Classifier-free guidance scale. Defaults to T3 Settings.",
      }),
    ),
    seed: Schema.optionalKey(
      Schema.Number.annotate({ description: "Optional deterministic seed." }),
    ),
  }),
  success: GenerateImageResult,
  failure: ImageGenerationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProcessRunner.ProcessRunner,
    FileSystem.FileSystem,
    Crypto.Crypto,
    ServerSettingsService,
  ],
})
  .annotate(Tool.Title, "Generate local image")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ImageGenerationToolkit = Toolkit.make(GenerateImageTool);
