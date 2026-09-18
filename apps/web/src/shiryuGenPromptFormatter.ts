import type { ShiryuGenPromptFormatInput, ShiryuGenPromptFormatResult } from "@t3tools/contracts";

import {
  expandShiryuGenConcept,
  textContainsAnyShiryuGenConcept,
  type ShiryuGenGenerationPolicy,
  type ShiryuGenGenerationSpec,
} from "./shiryuGenGenerationPolicy";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9 .:+()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalize(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function splitScene(value: string): string[] {
  return value
    .split(/[,;\n]|\.(?=\s|$)/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeSceneConcepts(
  value: string,
  forbiddenConcepts: readonly string[],
  forbiddenTags: readonly string[],
): string[] {
  return splitScene(value).filter(
    (clause) =>
      !textContainsAnyShiryuGenConcept(clause, forbiddenConcepts) &&
      !forbiddenTags.some((tag) => normalize(clause).includes(normalize(tag))),
  );
}

export function compileDeterministicShiryuGenPrompt(input: {
  spec: ShiryuGenGenerationSpec;
  policy: ShiryuGenGenerationPolicy;
}): ShiryuGenPromptFormatResult {
  const { spec, policy } = input;
  const optional = policy.optionalConcepts.flatMap((concept) =>
    safeSceneConcepts(concept, policy.forbiddenConcepts, policy.forbiddenTags),
  );
  const userScene =
    spec.scene.mode === "first-canon-reference"
      ? []
      : safeSceneConcepts(spec.scene.userPrompt, policy.forbiddenConcepts, policy.forbiddenTags);
  const positivePrompt = unique([
    ...policy.renderProfile.qualityPrefix,
    ...policy.requiredTags,
    ...policy.requiredConcepts,
    ...policy.optionalTags,
    ...optional,
    ...userScene,
    spec.style.medium,
    spec.style.rendering,
  ])
    .map((tag) =>
      spec.scene.mode === "first-canon-reference" &&
      /^kashiro\b/i.test(spec.characterName) &&
      policy.renderProfile.id === "nova-anime-illustrious" &&
      [
        "midnight-navy Asteria academy jacket",
        "single cloth wrap on LEFT forearm only",
        "right forearm and wrist unwrapped",
      ].includes(tag)
        ? `(${tag}:1.25)`
        : tag,
    )
    .join(", ");

  const negativePrompt = unique([
    ...policy.renderProfile.defaultNegative,
    ...policy.forbiddenTags,
    ...policy.forbiddenConcepts.flatMap((concept) => expandShiryuGenConcept(concept)),
  ]).join(", ");

  return {
    positivePrompt,
    negativePrompt,
    warnings: [],
    formatterModel: "deterministic canon compiler",
    usedFallback: false,
  };
}

export function buildShiryuGenPromptFormatInput(input: {
  spec: ShiryuGenGenerationSpec;
  policy: ShiryuGenGenerationPolicy;
  deterministic: ShiryuGenPromptFormatResult;
}): ShiryuGenPromptFormatInput {
  const { spec, policy, deterministic } = input;
  const lockedFacts = [
    `character name: ${spec.characterName}`,
    `presentation: ${spec.identity.presentation}`,
    `species: ${spec.identity.species}`,
    `age: ${spec.identity.age}`,
    `life stage: ${spec.identity.lifeStage}`,
    `classification: ${spec.identity.classification}`,
    `outfit: ${spec.outfit.name}`,
    `exact outfit details: ${spec.outfit.exactDetails}`,
    `visible magic: ${spec.continuity.visibleMagic}`,
    `power state: ${spec.continuity.powerState}`,
  ];
  return {
    modelProfile: {
      id: policy.renderProfile.id,
      label: policy.renderProfile.label,
      promptStyle: policy.renderProfile.promptStyle,
    },
    sceneMode: spec.scene.mode,
    lockedFacts,
    requiredConcepts: policy.requiredConcepts,
    optionalConcepts: policy.optionalConcepts,
    forbiddenConcepts: policy.forbiddenConcepts.flatMap((concept) =>
      expandShiryuGenConcept(concept),
    ),
    requiredTags: policy.requiredTags,
    optionalTags: policy.optionalTags,
    forbiddenTags: policy.forbiddenTags,
    userSceneRequest: spec.scene.userPrompt,
    styleRequirements: [spec.style.medium, spec.style.rendering],
    deterministicPositivePrompt: deterministic.positivePrompt,
    deterministicNegativePrompt: deterministic.negativePrompt,
  };
}
