import {
  containsShiryuGenConcept,
  textContainsAnyShiryuGenConcept,
  type ShiryuGenGenerationPolicy,
  type ShiryuGenGenerationSpec,
} from "./shiryuGenGenerationPolicy";
import type { ShiryuGenPromptFormatResult } from "@t3tools/contracts";

export interface ShiryuGenPromptValidationCheck {
  id: "identity" | "outfit" | "age" | "continuity" | "scene" | "model";
  label: "Identity" | "Outfit" | "Age" | "Continuity" | "Scene" | "Model";
  valid: boolean;
  message: string;
}

export interface ShiryuGenPromptValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: ShiryuGenPromptValidationCheck[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9 .:+()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !["the", "and", "with", "only"].includes(token));
}

function conceptRepresented(text: string, concept: string): boolean {
  if (containsShiryuGenConcept(text, concept)) return true;
  const normalizedText = normalize(text);
  const normalizedConcept = normalize(concept);
  if (!normalizedConcept) return true;
  const tokens = meaningfulTokens(concept);
  if (tokens.length < 3) return false;
  const matches = tokens.filter((token) => normalizedText.includes(token)).length;
  return matches / tokens.length >= 0.8;
}

function splitDetails(value: string): string[] {
  return value
    .split(/[,;\n]|\.(?=\s|$)/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function explicitAges(value: string): number[] {
  const ages = new Set<number>();
  for (const match of value.matchAll(/\b(\d{1,2})(?:[- ]year[- ]old|\s+years?\s+old)\b/gi)) {
    ages.add(Number(match[1]));
  }
  for (const match of value.matchAll(/\bage\s*:?\s*(\d{1,2})\b/gi)) {
    ages.add(Number(match[1]));
  }
  return [...ages].filter(Number.isFinite);
}

function makeCheck(
  id: ShiryuGenPromptValidationCheck["id"],
  label: ShiryuGenPromptValidationCheck["label"],
  valid: boolean,
  message: string,
): ShiryuGenPromptValidationCheck {
  return { id, label, valid, message };
}

export function validateShiryuGenFormattedPrompt(input: {
  spec: ShiryuGenGenerationSpec;
  policy: ShiryuGenGenerationPolicy;
  formatted: Pick<ShiryuGenPromptFormatResult, "positivePrompt" | "negativePrompt" | "warnings">;
}): ShiryuGenPromptValidationResult {
  const { spec, policy, formatted } = input;
  const positive = formatted.positivePrompt.trim();
  const negative = formatted.negativePrompt.trim();
  const errors: string[] = [];
  const warnings = [...formatted.warnings];

  if (!positive) errors.push("Renderer positive prompt is empty.");
  if (!negative) warnings.push("Renderer negative prompt is empty.");

  const identityRequirements = [
    spec.identity.species,
    spec.identity.presentation === "other"
      ? "androgynous presentation"
      : spec.identity.presentation,
    `${spec.identity.age}-year-old`,
    spec.identity.lifeStage === "young-adult" ? "young adult" : "adult",
  ];
  const missingIdentity = identityRequirements.filter(
    (concept) => !conceptRepresented(positive, concept),
  );
  const expectedPresentationTag =
    spec.identity.presentation === "male"
      ? "1boy"
      : spec.identity.presentation === "female"
        ? "1girl"
        : null;
  if (expectedPresentationTag && !conceptRepresented(positive, expectedPresentationTag)) {
    missingIdentity.push(expectedPresentationTag);
  }
  if (missingIdentity.length > 0) {
    errors.push(`Missing required identity: ${missingIdentity.join(", ")}.`);
  }

  const outfitRequirements = splitDetails(spec.outfit.exactDetails || spec.outfit.name);
  const missingOutfit = outfitRequirements.filter(
    (concept) => !conceptRepresented(positive, concept),
  );
  if (missingOutfit.length > 0) {
    errors.push(`Missing required outfit detail: ${missingOutfit.join(", ")}.`);
  }

  const contradictoryAges = explicitAges(positive).filter((age) => age !== spec.identity.age);
  if (!Number.isInteger(spec.identity.age) || spec.identity.age < 0) {
    errors.push("Character age is invalid.");
  } else if (spec.identity.classification === "student" && spec.identity.age < 18) {
    errors.push("Student generation identities must be age 18 or older.");
  } else if (contradictoryAges.length > 0) {
    errors.push(
      `Renderer prompt changed the character age: expected ${spec.identity.age}, found ${contradictoryAges.join(", ")}.`,
    );
  }

  const forbiddenPositive = policy.forbiddenConcepts.filter((concept) =>
    containsShiryuGenConcept(positive, concept),
  );
  const forbiddenTags = policy.forbiddenTags.filter((tag) => conceptRepresented(positive, tag));
  if (forbiddenPositive.length > 0 || forbiddenTags.length > 0) {
    errors.push(
      `Forbidden concept in positive prompt: ${[...forbiddenPositive, ...forbiddenTags].join(", ")}.`,
    );
  }

  const missingRequired = policy.requiredConcepts.filter(
    (concept) => !conceptRepresented(positive, concept),
  );
  const missingRequiredTags = policy.requiredTags.filter(
    (tag) => !conceptRepresented(positive, tag),
  );
  if (missingRequired.length > 0 || missingRequiredTags.length > 0) {
    errors.push(
      `Renderer prompt dropped required concepts: ${[...missingRequiredTags, ...missingRequired].join(", ")}.`,
    );
  }

  const requiredNegated = [...policy.requiredTags, ...policy.requiredConcepts].filter((concept) =>
    conceptRepresented(negative, concept),
  );
  if (requiredNegated.length > 0) {
    errors.push(`Negative prompt contradicts required canon: ${requiredNegated.join(", ")}.`);
  }

  const missingForbiddenNegative = policy.forbiddenConcepts.filter(
    (concept) => !conceptRepresented(negative, concept),
  );
  const missingForbiddenTagsNegative = policy.forbiddenTags.filter(
    (tag) => !conceptRepresented(negative, tag),
  );
  if (missingForbiddenNegative.length > 0 || missingForbiddenTagsNegative.length > 0) {
    errors.push(
      `Negative prompt dropped required safeguards: ${[
        ...missingForbiddenTagsNegative,
        ...missingForbiddenNegative,
      ].join(", ")}.`,
    );
  }

  const hasForbiddenVisibleMagic =
    spec.continuity.visibleMagic === "none" &&
    textContainsAnyShiryuGenConcept(positive, ["visible-magic"]);
  if (hasForbiddenVisibleMagic) {
    errors.push("Current continuity forbids visible magic, but a visible magic effect is present.");
  }
  const incompatibleMagicScene =
    spec.continuity.visibleMagic === "none" &&
    (spec.scene.mode === "magic-showcase" || spec.scene.mode === "transformation");
  if (incompatibleMagicScene) {
    errors.push(
      `${spec.scene.mode === "magic-showcase" ? "Magic showcase" : "Transformation"} is unavailable while the current continuity state forbids visible magic.`,
    );
  }

  const firstReference = spec.scene.mode === "first-canon-reference";
  const framingRequirements = firstReference
    ? ["full body", "hair-to-footwear visible", "three-quarter"]
    : [];
  const missingFraming = framingRequirements.filter((concept) => {
    if (concept === "hair-to-footwear visible") {
      return (
        !conceptRepresented(positive, "hair-to-footwear visible") &&
        !conceptRepresented(positive, "entire head and footwear visible")
      );
    }
    return !conceptRepresented(positive, concept);
  });
  if (missingFraming.length > 0) {
    errors.push(`First canon reference framing is incomplete: ${missingFraming.join(", ")}.`);
  }

  const profile = policy.renderProfile;
  const modelValid =
    Boolean(profile.id && profile.model) &&
    Number.isFinite(profile.width) &&
    Number.isFinite(profile.height) &&
    Number.isFinite(profile.steps) &&
    Number.isFinite(profile.guidance) &&
    Boolean(profile.sampler && profile.scheduler);
  if (!modelValid) errors.push("The resolved renderer model profile is incomplete.");

  const checks: ShiryuGenPromptValidationCheck[] = [
    makeCheck(
      "identity",
      "Identity",
      missingIdentity.length === 0,
      missingIdentity.length === 0
        ? `${spec.identity.presentation}, ${spec.identity.species}, ${spec.identity.lifeStage}`
        : `Missing ${missingIdentity.join(", ")}`,
    ),
    makeCheck(
      "outfit",
      "Outfit",
      missingOutfit.length === 0,
      missingOutfit.length === 0
        ? spec.outfit.exactDetails || spec.outfit.name || "No outfit requirement"
        : `Missing ${missingOutfit.join(", ")}`,
    ),
    makeCheck(
      "age",
      "Age",
      Number.isInteger(spec.identity.age) &&
        spec.identity.age >= 0 &&
        (spec.identity.classification !== "student" || spec.identity.age >= 18) &&
        contradictoryAges.length === 0,
      contradictoryAges.length === 0
        ? `${spec.identity.age}-year-old ${spec.identity.classification}`
        : `Expected ${spec.identity.age}; contradictory age ${contradictoryAges.join(", ")}`,
    ),
    makeCheck(
      "continuity",
      "Continuity",
      forbiddenPositive.length === 0 &&
        !hasForbiddenVisibleMagic &&
        !incompatibleMagicScene &&
        missingForbiddenNegative.length === 0 &&
        missingForbiddenTagsNegative.length === 0,
      incompatibleMagicScene
        ? `${spec.scene.mode} conflicts with visible magic ${spec.continuity.visibleMagic}`
        : `${spec.continuity.powerState}; visible magic ${spec.continuity.visibleMagic}`,
    ),
    makeCheck(
      "scene",
      "Scene",
      missingFraming.length === 0 &&
        missingRequired.length === 0 &&
        missingRequiredTags.length === 0 &&
        requiredNegated.length === 0,
      firstReference ? "First canon reference framing locked" : spec.scene.mode,
    ),
    makeCheck(
      "model",
      "Model",
      modelValid,
      `${profile.label} · ${profile.width}×${profile.height} · ${profile.sampler}/${profile.scheduler}`,
    ),
  ];

  return { valid: errors.length === 0, errors, warnings, checks };
}
