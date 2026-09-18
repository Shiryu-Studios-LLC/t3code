import type {
  LocalImageGenerateInput,
  LocalImageModel,
  ShiryuGenPromptFormatResult,
  ShiryuGenPromptFormatInput,
  ThreadId,
} from "@t3tools/contracts";

import {
  buildShiryuGenGenerationPolicy,
  containsShiryuGenConcept,
  createShiryuGenGenerationSpec,
  type ShiryuGenContinuityState,
  type ShiryuGenGenerationPolicy,
  type ShiryuGenGenerationSpec,
  type ShiryuGenSceneMode,
} from "./shiryuGenGenerationPolicy";
import { migrateGenerationIdentity } from "./shiryuGenIdentity";
import {
  buildShiryuGenPromptFormatInput,
  compileDeterministicShiryuGenPrompt,
} from "./shiryuGenPromptFormatter";
import { validateShiryuGenFormattedPrompt } from "./shiryuGenPromptValidator";
import type {
  ShiryuGenCharacterGenerationIntent,
  ShiryuGenCharacterKit,
  ShiryuGenConsistencyStrategy,
  ShiryuGenReferenceAsset,
  ShiryuGenSeries,
} from "./shiryuGenProductionStore";

export const SHIRYUGEN_CONSISTENCY_STRATEGIES: ReadonlyArray<{
  value: ShiryuGenConsistencyStrategy;
  label: string;
  executable: boolean;
  description: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    executable: true,
    description:
      "Use enabled Character LoRAs where appropriate (supports both reference image and Character LoRA together).",
  },
  {
    value: "canon-reference",
    label: "Canon Reference",
    executable: true,
    description:
      "Use the Canon/Approved reference image path as its primary consistency method (LoRAs are not used).",
  },
  {
    value: "character-lora",
    label: "Character LoRA",
    executable: true,
    description:
      "Explicitly require and use the enabled Character LoRA without an image reference.",
  },
  {
    value: "ipadapter",
    label: "IPAdapter",
    executable: false,
    description:
      "Reserved for a validated IPAdapter workflow once the required ComfyUI nodes are installed.",
  },
  {
    value: "advanced",
    label: "Advanced",
    executable: false,
    description: "Reserved for explicit identity/pose/style/ControlNet layer selection.",
  },
];

const CHARACTER_FURRY_PATTERN =
  /\b(?:furry|anthro|anthropomorphic|kitsune|kemono|fox|wolf|canine|feline|cat|dog)\b/i;
const FIRST_CANON_REFERENCE_PATTERN = /^full-body character reference\b/i;
const CHARACTER_COMPOSITION_NEGATIVE =
  "chibi, super-deformed, comic page, manga panel layout, split panel, collage, contact sheet, multiple versions of the same character, duplicate character, cropped head, cropped feet, feet-only close-up, shoe-only close-up, extreme fisheye, extra limbs, extra fingers, malformed hands, bad anatomy, text, watermark, logo";

export function selectableCharacterReferences(
  character: ShiryuGenCharacterKit,
): ShiryuGenReferenceAsset[] {
  return character.referenceAssets
    .filter((asset) => asset.status === "canon" || asset.status === "approved")
    .toSorted((a, b) => {
      const authority = (asset: ShiryuGenReferenceAsset) => (asset.status === "canon" ? 0 : 1);
      return authority(a) - authority(b) || b.createdAt.localeCompare(a.createdAt);
    });
}

export function inferCharacterImageModel(character: ShiryuGenCharacterKit): LocalImageModel {
  const species =
    character.generationIdentity?.species ?? migrateGenerationIdentity(character).species;
  return CHARACTER_FURRY_PATTERN.test(species) ? "nova-furry" : "nova-anime";
}

function uniquePromptParts(parts: readonly string[]): string {
  const seen = new Set<string>();
  return parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => {
      const key = part.toLowerCase().replace(/\s+/g, " ");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
}

/** Compatibility helper used by existing Character Kit tests and non-preview callers. */
export function buildCharacterGenerationNegativePrompt(
  character: ShiryuGenCharacterKit,
  firstCanonReference: boolean,
): string {
  const identity = character.generationIdentity ?? migrateGenerationIdentity(character);
  const parts = [CHARACTER_COMPOSITION_NEGATIVE];
  if (identity.age !== null && identity.age >= 18) {
    parts.push("child, underage, preteen, young child, middle schooler");
  }
  if (identity.species.toLowerCase() === "human") {
    parts.push("furry, anthropomorphic, animal ears, animal tail, muzzle, snout, animal face");
  }
  if (identity.presentation === "male") parts.push("1girl, female, woman, feminine body");
  if (identity.presentation === "female") parts.push("1boy, male, man, masculine body");
  if (identity.visibleMagic === "none") {
    parts.push(
      "visible magic, magic aura, energy aura, sparks, runes, sigils, spell circles, magic circles, glowing eyes, elemental effects, holographic overlays, magical HUD, supernatural scanning effects",
    );
  }
  if (firstCanonReference) {
    parts.push("dramatic action, motion blur, extreme camera angles, extreme perspective");
  }
  return uniquePromptParts(parts);
}

export function validateFirstCanonPrompt(character: ShiryuGenCharacterKit, prompt: string): void {
  const identity = character.generationIdentity;
  if (
    !identity ||
    identity.presentation === "unspecified" ||
    !identity.species.trim() ||
    identity.age === null ||
    !Number.isInteger(identity.age) ||
    identity.age < 0 ||
    identity.lifeStage === "unspecified"
  ) {
    throw new Error(
      "Set the Character Kit's generation identity (presentation, species, age and life stage) before creating a first canon reference.",
    );
  }
  if (identity.classification === "student" && identity.age < 18) {
    throw new Error("The adult generation identity needs an age of at least 18.");
  }
  if (
    (identity.presentation === "male" && !/\b1boy\b/i.test(prompt)) ||
    (identity.presentation === "female" && !/\b1girl\b/i.test(prompt))
  ) {
    throw new Error("The reference prompt is missing the character's explicit presentation.");
  }
  if (identity.visibleMagic === "none" && containsShiryuGenConcept(prompt, "visible-magic")) {
    throw new Error(
      "The reference prompt still contains a visible magic effect. Check the identity and continuity policy.",
    );
  }
}

export interface PreparedCharacterGenerationPipeline {
  spec: ShiryuGenGenerationSpec;
  policy: ShiryuGenGenerationPolicy;
  deterministic: ShiryuGenPromptFormatResult;
  validation: ReturnType<typeof validateShiryuGenFormattedPrompt>;
}

export function prepareCharacterGenerationPipeline(input: {
  series: ShiryuGenSeries;
  character: ShiryuGenCharacterKit;
  outfit: string;
  scenePrompt: string;
  sceneMode: ShiryuGenSceneMode;
  continuity?: ShiryuGenContinuityState;
  reference?: ShiryuGenReferenceAsset | null;
}): PreparedCharacterGenerationPipeline {
  const spec = createShiryuGenGenerationSpec({
    series: input.series,
    character: input.character,
    outfit: input.outfit,
    scenePrompt: input.scenePrompt,
    sceneMode: input.sceneMode,
    ...(input.continuity ? { continuity: input.continuity } : {}),
    referenceState:
      input.reference?.status === "canon"
        ? "canon"
        : input.reference?.status === "approved"
          ? "approved"
          : "none",
  });
  const policy = buildShiryuGenGenerationPolicy({ spec, character: input.character });
  const deterministic = compileDeterministicShiryuGenPrompt({ spec, policy });
  const validation = validateShiryuGenFormattedPrompt({ spec, policy, formatted: deterministic });
  return { spec, policy, deterministic, validation };
}

/** First references never dispatch an AI request; every result still passes canon validation. */
export async function prepareCharacterRendererPrompt(
  pipeline: PreparedCharacterGenerationPipeline,
  format: (input: ShiryuGenPromptFormatInput) => Promise<ShiryuGenPromptFormatResult>,
): Promise<ShiryuGenPromptFormatResult> {
  let formatted = pipeline.deterministic;
  if (pipeline.spec.scene.mode !== "first-canon-reference") {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      formatted = await Promise.race([
        format(buildShiryuGenPromptFormatInput(pipeline)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Formatter timed out")), 11_000);
        }),
      ]);
    } catch {
      formatted = {
        ...pipeline.deterministic,
        usedFallback: true,
        warnings: ["Local prompt formatter unavailable — using deterministic prompt."],
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  const validation = validateShiryuGenFormattedPrompt({ ...pipeline, formatted });
  if (!validation.valid) throw new Error(`Generation blocked: ${validation.errors.join(" ")}`);
  return formatted;
}

export function selectedCharacterLoras(
  character: ShiryuGenCharacterKit,
  strategy: ShiryuGenConsistencyStrategy,
) {
  return strategy === "auto" || strategy === "character-lora"
    ? (character.characterLoras ?? []).filter((lora) => lora.enabled && lora.path.trim())
    : [];
}

export function buildCharacterGenerationPrompt(input: {
  series: ShiryuGenSeries;
  character: ShiryuGenCharacterKit;
  outfit: string;
  scenePrompt: string;
  reference?: ShiryuGenReferenceAsset | null;
  firstCanonReference?: boolean;
  sceneMode?: ShiryuGenSceneMode;
  continuity?: ShiryuGenContinuityState;
}): string {
  const firstCanonReference =
    input.firstCanonReference ?? FIRST_CANON_REFERENCE_PATTERN.test(input.scenePrompt.trim());
  const sceneMode =
    input.sceneMode ?? (firstCanonReference ? "first-canon-reference" : "story-scene");
  return prepareCharacterGenerationPipeline({
    series: input.series,
    character: input.character,
    outfit: input.outfit,
    scenePrompt: input.scenePrompt,
    sceneMode,
    ...(input.continuity ? { continuity: input.continuity } : {}),
    ...(firstCanonReference
      ? { reference: null }
      : input.reference !== undefined
        ? { reference: input.reference }
        : {}),
  }).deterministic.positivePrompt;
}

export function buildCharacterGenerationImageInput(
  threadId: ThreadId,
  intent: ShiryuGenCharacterGenerationIntent,
): LocalImageGenerateInput {
  return {
    threadId,
    prompt: intent.prompt,
    requestText: intent.requestText,
    skipPromptRefinement: true,
    ...(intent.negativePrompt ? { negativePrompt: intent.negativePrompt } : {}),
    ...(intent.model ? { model: intent.model } : {}),
    ...(intent.width !== undefined ? { width: intent.width } : {}),
    ...(intent.height !== undefined ? { height: intent.height } : {}),
    ...(intent.steps !== undefined ? { steps: intent.steps } : {}),
    ...(intent.guidance !== undefined ? { guidance: intent.guidance } : {}),
    ...(intent.sampler ? { sampler: intent.sampler } : {}),
    ...(intent.scheduler ? { scheduler: intent.scheduler } : {}),
    ...(intent.referenceAttachmentId
      ? { referenceAttachmentId: intent.referenceAttachmentId }
      : {}),
    ...(intent.checkpointPath ? { checkpointPath: intent.checkpointPath } : {}),
    loras: (intent.loras ?? []).map((lora) => ({
      name: lora.name,
      path: lora.path,
      weight: lora.weight,
    })),
    ...(intent.modelProfile && intent.policyVersion
      ? {
          shiryuGenMetadata: {
            character: intent.characterName,
            sceneMode: intent.sceneMode,
            modelProfile: intent.modelProfile,
            policyVersion: intent.policyVersion,
            referenceState: intent.references[0]?.status ?? "none",
            formatterModel: intent.formatterModel ?? "deterministic canon compiler",
            formatterFallback: intent.formatterFallback ?? false,
            promptSource:
              !intent.formatterModel ||
              intent.formatterModel === "deterministic canon compiler" ||
              intent.formatterFallback
                ? "deterministic"
                : "local formatter",
          },
        }
      : {}),
  };
}

export function createCharacterGenerationIntent(input: {
  series: ShiryuGenSeries;
  character: ShiryuGenCharacterKit;
  outfit: string;
  scenePrompt: string;
  reference?: ShiryuGenReferenceAsset | null;
  strategy?: ShiryuGenConsistencyStrategy;
  firstCanonReference?: boolean;
  sceneMode?: ShiryuGenSceneMode;
  continuity?: ShiryuGenContinuityState;
  formattedPrompt?: ShiryuGenPromptFormatResult | null;
}): ShiryuGenCharacterGenerationIntent {
  const scenePrompt = input.scenePrompt.trim();
  if (!scenePrompt) {
    throw new Error("Describe what the character should be doing before generating.");
  }

  const strategy = input.strategy ?? input.character.preferredConsistencyStrategy ?? "auto";
  const strategyInfo = SHIRYUGEN_CONSISTENCY_STRATEGIES.find((entry) => entry.value === strategy);
  if (!strategyInfo?.executable) {
    throw new Error(
      `${strategyInfo?.label ?? strategy} is prepared in ShiryuGen's consistency architecture but is not executable yet. No unvalidated ComfyUI nodes will be invented or installed automatically.`,
    );
  }

  const reference = input.reference ?? null;
  if (reference?.status === "rejected" || reference?.status === "draft") {
    throw new Error("Only Canon or Approved references can drive character generation.");
  }

  const inferredFirstReference =
    input.firstCanonReference ?? FIRST_CANON_REFERENCE_PATTERN.test(scenePrompt);
  const sceneMode =
    input.sceneMode ?? (inferredFirstReference ? "first-canon-reference" : "story-scene");
  const firstCanonReference = sceneMode === "first-canon-reference";
  const durableReference =
    reference?.sourceKind === "chat-attachment" && reference.attachmentId ? reference : null;
  const enabledLoras = (input.character.characterLoras ?? []).filter(
    (lora) => lora.enabled && lora.path.trim().length > 0,
  );

  if (strategy === "canon-reference" && !durableReference && !firstCanonReference) {
    throw new Error(
      "Canon Reference needs a Canon/Approved image that was added from a ShiryuGen chat so it has a durable attachment ID.",
    );
  }
  if (strategy === "character-lora" && enabledLoras.length === 0) {
    throw new Error(
      "Character LoRA needs at least one enabled LoRA association on this Character Kit.",
    );
  }

  const useReference = firstCanonReference
    ? null
    : strategy === "canon-reference" || strategy === "auto"
      ? durableReference
      : null;
  const useLoras = selectedCharacterLoras(input.character, strategy);
  const pipeline = prepareCharacterGenerationPipeline({
    series: input.series,
    character: input.character,
    outfit: input.outfit,
    scenePrompt,
    sceneMode,
    ...(input.continuity ? { continuity: input.continuity } : {}),
    reference: useReference,
  });
  const formatted = input.formattedPrompt ?? pipeline.deterministic;
  const validation = validateShiryuGenFormattedPrompt({
    spec: pipeline.spec,
    policy: pipeline.policy,
    formatted,
  });
  if (!validation.valid) {
    throw new Error(`Generation blocked: ${validation.errors.join(" ")}`);
  }

  const profile = pipeline.policy.renderProfile;
  return {
    id: `character-generation-${Date.now().toString(36)}`,
    seriesId: input.series.id,
    characterId: input.character.id,
    characterName: input.character.name,
    outfit: input.outfit.trim(),
    scenePrompt,
    sceneMode,
    prompt: formatted.positivePrompt,
    requestText: `Generate ${input.character.name}: ${scenePrompt}`,
    consistencyStrategy: strategy,
    references: useReference
      ? [
          {
            assetId: useReference.id,
            ...(useReference.attachmentId ? { attachmentId: useReference.attachmentId } : {}),
            purpose: useReference.purpose ?? "primary",
            status: useReference.status as "canon" | "approved",
          },
        ]
      : [],
    ...(useReference ? { referenceAssetId: useReference.id } : {}),
    ...(useReference?.attachmentId ? { referenceAttachmentId: useReference.attachmentId } : {}),
    ...(pipeline.spec.checkpointPath ? { checkpointPath: pipeline.spec.checkpointPath } : {}),
    model: pipeline.spec.model,
    negativePrompt: formatted.negativePrompt,
    width: profile.width,
    height: profile.height,
    steps: profile.steps,
    guidance: profile.guidance,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    modelProfile: profile.id,
    policyVersion: pipeline.policy.version,
    promptWarnings: [...formatted.warnings],
    ...(formatted.formatterModel ? { formatterModel: formatted.formatterModel } : {}),
    formatterFallback: formatted.usedFallback,
    ...(firstCanonReference ? { firstCanonReference: true } : {}),
    loras: useLoras.map((lora) => ({ ...lora })),
    createdAt: new Date().toISOString(),
  };
}
