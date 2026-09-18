import type { LocalImageModel } from "@t3tools/contracts";
import { resolveImageGenerationProfile } from "@t3tools/shared/imageGenerationProfiles";

export type ShiryuGenPromptStyle = "tag" | "hybrid" | "natural";

export interface ShiryuGenModelProfile {
  id: string;
  label: string;
  model: LocalImageModel;
  checkpointPath?: string;
  promptStyle: ShiryuGenPromptStyle;
  qualityPrefix: string[];
  defaultNegative: string[];
  width: number;
  height: number;
  steps: number;
  guidance: number;
  sampler: string;
  scheduler: string;
}

const MODEL_LABELS: Record<LocalImageModel, string> = {
  "nova-unreal": "Nova Unreal XL",
  "nova-anime": "Nova Anime XL",
  "perfect-anima": "Perfect Anima AIO",
  "nova-furry": "Nova Furry XL",
  "nova-pkm": "Nova PKM XL",
  "nova-mature": "Nova Mature XL",
  custom: "Custom checkpoint",
};

function promptStyleForModel(model: LocalImageModel, baseModel: string): ShiryuGenPromptStyle {
  if (model === "nova-anime" || /illustrious|pony/i.test(baseModel)) return "tag";
  if (model === "nova-furry" || model === "nova-pkm" || model === "perfect-anima") {
    return "hybrid";
  }
  return "natural";
}

function splitPromptList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Character generation resolves a renderer profile from the character's explicit
 * model/checkpoint selection. This keeps specialized global checkpoints from leaking
 * into Character Kit renders.
 */
export function resolveShiryuGenModelProfile(input: {
  model: LocalImageModel;
  checkpointPath?: string;
}): ShiryuGenModelProfile {
  const checkpoint = input.checkpointPath?.trim() || input.model;
  const resolved = resolveImageGenerationProfile(checkpoint);
  return {
    id: resolved.id,
    label: MODEL_LABELS[input.model],
    model: input.model,
    ...(input.checkpointPath?.trim() ? { checkpointPath: input.checkpointPath.trim() } : {}),
    promptStyle: promptStyleForModel(input.model, resolved.baseModel),
    qualityPrefix: splitPromptList(resolved.positivePrefix),
    defaultNegative: splitPromptList(resolved.negativeBaseline),
    width: resolved.width,
    height: resolved.height,
    steps: resolved.steps,
    guidance: resolved.guidance,
    sampler: resolved.sampler,
    scheduler: resolved.scheduler,
  };
}
