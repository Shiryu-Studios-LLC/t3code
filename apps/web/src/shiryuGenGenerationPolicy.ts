import type { LocalImageModel } from "@t3tools/contracts";

import type { ShiryuGenGenerationIdentity } from "./shiryuGenIdentity";
import { resolveShiryuGenModelProfile, type ShiryuGenModelProfile } from "./shiryuGenModelProfiles";
import type { ShiryuGenCharacterKit, ShiryuGenSeries } from "./shiryuGenProductionStore";

export const SHIRYUGEN_GENERATION_POLICY_VERSION = "shiryugen-policy-v2";

export type ShiryuGenSceneMode =
  | "first-canon-reference"
  | "story-scene"
  | "classroom-scene"
  | "emotional-closeup"
  | "action-scene"
  | "magic-showcase"
  | "transformation";

export interface ShiryuGenContinuityState {
  storyPhase?: string | null;
  arcId?: string | null;
  powerState?: "baseline" | "awakened" | "transformed" | "custom";
  allowVisibleMagicOverride?: boolean | null;
}

export interface ShiryuGenGenerationSpec {
  characterId: string;
  characterName: string;
  series: {
    title: string;
    styleRules: string;
  };
  identity: {
    presentation: ShiryuGenGenerationIdentity["presentation"];
    species: string;
    age: number;
    lifeStage: ShiryuGenGenerationIdentity["lifeStage"];
    classification: ShiryuGenGenerationIdentity["classification"];
  };
  appearance: {
    visualTraits: string;
  };
  outfit: {
    name: string;
    exactDetails: string;
  };
  scene: {
    mode: ShiryuGenSceneMode;
    userPrompt: string;
    framing?: string;
    pose?: string;
    environment?: string;
    lighting?: string;
  };
  continuity: {
    visibleMagic: ShiryuGenGenerationIdentity["visibleMagic"];
    powerState: NonNullable<ShiryuGenContinuityState["powerState"]>;
    storyPhase?: string | null;
    arcId?: string | null;
  };
  style: {
    medium: string;
    rendering: string;
  };
  model: LocalImageModel;
  checkpointPath?: string;
  characterLoras: ReadonlyArray<{
    id: string;
    name: string;
    path: string;
    weight: number;
    enabled: boolean;
  }>;
  referenceState: "none" | "canon" | "approved";
}

export interface ShiryuGenValidationRule {
  id: string;
  label: "Identity" | "Outfit" | "Age" | "Continuity" | "Scene" | "Model";
  description: string;
}

export interface ShiryuGenGenerationPolicy {
  version: string;
  requiredConcepts: string[];
  optionalConcepts: string[];
  forbiddenConcepts: string[];
  requiredTags: string[];
  optionalTags: string[];
  forbiddenTags: string[];
  renderProfile: ShiryuGenModelProfile;
  validationRules: ShiryuGenValidationRule[];
}

export const SHIRYUGEN_CONCEPT_ALIASES = {
  "visible-magic": [
    "aura",
    "visible magic",
    "magic aura",
    "magical aura",
    "energy aura",
    "energy effects",
    "magical glow",
    "spell effects",
    "magic circle",
    "magic circles",
    "spell circle",
    "spell circles",
    "runes",
    "rune",
    "sigils",
    "sigil",
    "sparks",
    "elemental effects",
    "glowing eyes",
    "holographic overlays",
    "magical hud",
    "supernatural scanning effects",
  ],
  "animal-traits": [
    "animal ears",
    "animal tail",
    "fox ears",
    "fox tail",
    "muzzle",
    "snout",
    "furry traits",
    "furry",
    "anthropomorphic",
    "kemono",
  ],
  "female-presentation": ["1girl", "female", "woman", "feminine body", "girl"],
  "male-presentation": ["1boy", "male", "man", "masculine body", "boy"],
  "underage-appearance": [
    "child",
    "underage",
    "preteen",
    "young child",
    "middle schooler",
    "teenager",
    "teenage",
    "teenage build",
    "adolescent",
    "childlike proportions",
  ],
  "duplicate-character": [
    "duplicate character",
    "multiple versions of the same character",
    "contact sheet",
    "collage",
  ],
  "split-layout": ["split panel", "split panels", "comic page", "manga panel layout"],
  "extreme-camera": [
    "extreme camera angle",
    "extreme camera angles",
    "extreme perspective",
    "fisheye",
  ],
  transformation: ["transformation", "powered-up transformation", "transformed form"],
  chibi: ["chibi", "super-deformed"],
} as const;

export type ShiryuGenConceptGroup = keyof typeof SHIRYUGEN_CONCEPT_ALIASES;

const FIRST_REFERENCE_MODE: ShiryuGenSceneMode = "first-canon-reference";
const FURRY_SPECIES =
  /\b(?:kitsune|fox|furry|anthro|anthropomorphic|kemono|wolf|canine|feline|cat|dog)\b/i;
const NEGATION = /\b(?:no|not|never|without|avoid|forbid|forbidden|must not|cannot|can't)\b/i;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9 .:+()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function expandShiryuGenConcept(concept: string): readonly string[] {
  if (concept in SHIRYUGEN_CONCEPT_ALIASES) {
    return SHIRYUGEN_CONCEPT_ALIASES[concept as ShiryuGenConceptGroup];
  }
  return [concept];
}

export function containsShiryuGenConcept(text: string, concept: string): boolean {
  const haystack = ` ${normalize(text)} `;
  return expandShiryuGenConcept(concept).some((alias) => {
    const needle = normalize(alias);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

export function textContainsAnyShiryuGenConcept(
  text: string,
  concepts: readonly string[],
): boolean {
  return concepts.some((concept) => containsShiryuGenConcept(text, concept));
}

function splitConceptText(value: string): string[] {
  return value
    .split(/[,;\n]|\.(?=\s|$)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitCanonStatements(value: string): string[] {
  return value
    .split(/[;\n]|[.!?](?=\s|$)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

const NARRATIVE_OR_BEHAVIORAL_PATTERN =
  /\b(?:spoiler|spoiled|fearless|arrogant|reckless|personality|secret|story|reveal|behav|dialogue|plot|thought|attitude|feeling|mood|confidence|cowardly|kind|cruel|temperament)\w*/i;

const VISUAL_ANCHOR_PATTERN =
  /\b(?:jacket|coat|hoodie|shirt|trousers|pants|shorts|skirt|boots|shoes|footwear|sportswear|tracksuit|hair|eyes|ears|tail|wings|horns|halo|armor|armour|weapon|sword|blade|dagger|bow|shield|gloves|gauntlets|bandages?|wrap|wrapped|bandaged|tattoo|scars?|glasses|eyewear|cape|cloak|robe|jewelry|amulet|necklace|ring|earrings?|aura|magic|runes?|sigils?)\b/i;

const LEADING_DISCARD_VERBS =
  /^(?:and|or|nor|but|be|become|display|show|have|include|use|wear|add|depict|feature|present|generate|render|contain|seen|look|appear)\s+/i;

function extractNegatedCanonPhrases(
  canonicalRules: string,
  options: { allowVisibleMagic: boolean },
): string[] {
  const forbidden: string[] = [];
  for (const statement of splitCanonStatements(canonicalRules)) {
    const negation = statement.match(NEGATION);
    if (!negation || negation.index === undefined) continue;
    const scope = statement.slice(negation.index + negation[0].length).trim();
    // Only explicit visual noun phrases belong in renderer negatives.
    // Narrative clauses (secrets, personality, future events) are not image tags.
    if (NARRATIVE_OR_BEHAVIORAL_PATTERN.test(scope)) continue;
    for (const fragment of scope.split(/,|\band\b/i)) {
      let cleaned = fragment.trim();
      cleaned = cleaned.replace(NEGATION, "").trim();
      while (LEADING_DISCARD_VERBS.test(cleaned)) {
        cleaned = cleaned.replace(LEADING_DISCARD_VERBS, "").trim();
      }
      cleaned = cleaned.replace(/^(?:any|a|an|the)\s+/i, "").trim();
      cleaned = cleaned.replace(/\s+(?:early|later|soon|prematurely)$/i, "").trim();
      if (
        cleaned &&
        cleaned.length >= 3 &&
        cleaned.length <= 80 &&
        !NARRATIVE_OR_BEHAVIORAL_PATTERN.test(cleaned) &&
        !/\b(?:be|become|feel|act|naturally|early|later|use)\b/i.test(cleaned) &&
        (VISUAL_ANCHOR_PATTERN.test(cleaned) ||
          containsShiryuGenConcept(cleaned, "visible-magic") ||
          containsShiryuGenConcept(cleaned, "animal-traits")) &&
        !(options.allowVisibleMagic && containsShiryuGenConcept(cleaned, "visible-magic"))
      ) {
        forbidden.push(cleaned);
      }
    }
  }
  return unique(forbidden);
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

function ensureExplicitIdentity(character: ShiryuGenCharacterKit): ShiryuGenGenerationIdentity {
  const identity = character.generationIdentity;
  if (!identity) {
    throw new Error(
      "Set the Character Kit's structured generation identity before preparing a renderer prompt.",
    );
  }
  if (
    identity.presentation === "unspecified" ||
    !identity.species.trim() ||
    identity.age === null ||
    !Number.isInteger(identity.age) ||
    identity.age < 0 ||
    identity.lifeStage === "unspecified"
  ) {
    throw new Error(
      "Complete presentation, species, age and life stage in the Character Kit before preparing a renderer prompt.",
    );
  }
  if (identity.classification === "student" && identity.age < 18) {
    throw new Error("Student generation identities must be age 18 or older.");
  }
  return identity;
}

function resolveCharacterModel(character: ShiryuGenCharacterKit, species: string): LocalImageModel {
  if (character.preferredCheckpointPath?.trim()) return "custom";
  return FURRY_SPECIES.test(species) ? "nova-furry" : "nova-anime";
}

function currentVisibleMagic(
  identity: ShiryuGenGenerationIdentity,
  continuity: ShiryuGenContinuityState,
): ShiryuGenGenerationIdentity["visibleMagic"] {
  return continuity.allowVisibleMagicOverride === true ? "allowed" : identity.visibleMagic;
}

function extractPositiveCanonConcepts(canonicalRules: string): string[] {
  return unique(
    splitCanonStatements(canonicalRules).flatMap((statement) =>
      NEGATION.test(statement)
        ? []
        : splitConceptText(statement).filter((clause) => clause.length <= 180),
    ),
  );
}

function extractKnownCanonForbiddenGroups(
  canonicalRules: string,
  options: { allowVisibleMagic: boolean },
): string[] {
  const groups: string[] = [];
  for (const statement of splitCanonStatements(canonicalRules)) {
    if (!NEGATION.test(statement)) continue;
    for (const concept of Object.keys(SHIRYUGEN_CONCEPT_ALIASES) as ShiryuGenConceptGroup[]) {
      if (concept === "visible-magic" && options.allowVisibleMagic) continue;
      if (containsShiryuGenConcept(statement, concept)) groups.push(concept);
    }
  }
  return unique(groups);
}

function firstReferenceRequiredConcepts(spec: ShiryuGenGenerationSpec): string[] {
  const common = [
    spec.identity.species,
    spec.identity.presentation === "other"
      ? "androgynous presentation"
      : spec.identity.presentation,
    `${spec.identity.age}-year-old`,
    spec.identity.lifeStage === "young-adult" ? "young adult" : "adult",
    ...splitConceptText(spec.appearance.visualTraits),
    ...splitConceptText(spec.outfit.exactDetails || spec.outfit.name),
    "full body",
    "entire head and footwear visible",
    "relaxed neutral three-quarter stance",
    "arms naturally at sides",
    "Asteria stone courtyard",
    "soft daylight",
    "clean 2D Japanese anime",
    "crisp cel shading",
  ];

  if (/^kashiro\b/i.test(spec.characterName)) {
    return unique([
      "human",
      "male",
      "18-year-old",
      "young adult",
      "adult height and proportions",
      "slim wiry young adult build",
      "mature young-adult anime facial proportions",
      "slightly messy layered raven-black hair",
      "slate gray-blue eyes",
      "midnight-navy Asteria academy jacket",
      "silver trim",
      "charcoal trousers",
      "dark boots",
      "single cloth wrap on LEFT forearm only",
      "right forearm and wrist unwrapped",
      "calm observant expression",
      "full body",
      "entire head and footwear visible",
      "relaxed neutral three-quarter stance",
      "arms naturally at sides",
      "Asteria stone courtyard",
      "soft daylight",
      "ordinary non-magical appearance",
      "clean 2D Japanese anime",
      "crisp cel shading",
    ]);
  }

  return unique(common);
}

function firstReferenceForbidden(spec: ShiryuGenGenerationSpec): string[] {
  const forbidden = ["duplicate-character", "split-layout", "extreme-camera", "chibi"];
  if (spec.identity.age >= 18) forbidden.push("underage-appearance");
  if (spec.identity.presentation === "male") forbidden.push("female-presentation");
  if (spec.identity.presentation === "female") forbidden.push("male-presentation");
  if (normalize(spec.identity.species) === "human") forbidden.push("animal-traits");
  if (spec.continuity.visibleMagic === "none") {
    forbidden.push("visible-magic", "transformation");
  }
  if (/^kashiro\b/i.test(spec.characterName)) {
    forbidden.push(
      "white jacket",
      "white academy jacket",
      "tracksuit",
      "track jacket",
      "sportswear",
      "athletic jacket",
      "striped sports jacket",
      "bandaged hand",
      "wrapped hand",
      "wrapped right wrist",
      "bandaged right arm",
    );
  }
  forbidden.push("dramatic action", "motion blur");
  return unique(forbidden);
}

function requiredTags(spec: ShiryuGenGenerationSpec): string[] {
  const tags = [spec.scene.mode === FIRST_REFERENCE_MODE ? "solo" : ""];
  if (spec.identity.presentation === "male") tags.unshift("1boy");
  if (spec.identity.presentation === "female") tags.unshift("1girl");
  return unique(tags);
}

function sceneModeConcepts(spec: ShiryuGenGenerationSpec): string[] {
  switch (spec.scene.mode) {
    case "first-canon-reference":
      return [];
    case "classroom-scene":
      return ["academy classroom", "natural academy-life composition"];
    case "emotional-closeup":
      return ["emotional close-up", "face and hairstyle clearly readable"];
    case "action-scene":
      return ["dynamic action scene", "character identity remains readable"];
    case "magic-showcase":
      return spec.continuity.visibleMagic === "allowed"
        ? ["visible magic appropriate to current canon"]
        : [];
    case "transformation":
      return spec.continuity.visibleMagic === "allowed" ? ["current canon transformation"] : [];
    case "story-scene":
      return [];
  }
}

export function createShiryuGenGenerationSpec(input: {
  series: ShiryuGenSeries;
  character: ShiryuGenCharacterKit;
  outfit: string;
  scenePrompt: string;
  sceneMode: ShiryuGenSceneMode;
  continuity?: ShiryuGenContinuityState;
  referenceState?: ShiryuGenGenerationSpec["referenceState"];
}): ShiryuGenGenerationSpec {
  const identity = ensureExplicitIdentity(input.character);
  const continuity = input.continuity ?? {};
  const visibleMagic = currentVisibleMagic(identity, continuity);
  const model = resolveCharacterModel(input.character, identity.species);
  const outfitName = input.outfit.trim();
  const exactDetails = input.character.outfitDetails?.[outfitName]?.trim() || outfitName;
  return {
    characterId: input.character.id,
    characterName: input.character.name,
    series: {
      title: input.series.title.trim(),
      styleRules: input.series.styleRules.trim(),
    },
    identity: {
      presentation: identity.presentation,
      species: identity.species.trim(),
      age: identity.age!,
      lifeStage: identity.lifeStage,
      classification: identity.classification,
    },
    appearance: { visualTraits: input.character.visualTraits.trim() },
    outfit: { name: outfitName, exactDetails },
    scene: {
      mode: input.sceneMode,
      userPrompt: input.scenePrompt.trim(),
    },
    continuity: {
      visibleMagic,
      powerState: continuity.powerState ?? "baseline",
      ...(continuity.storyPhase !== undefined ? { storyPhase: continuity.storyPhase } : {}),
      ...(continuity.arcId !== undefined ? { arcId: continuity.arcId } : {}),
    },
    style: {
      medium: "clean 2D Japanese anime",
      rendering: "crisp cel shading",
    },
    model,
    ...(input.character.preferredCheckpointPath?.trim()
      ? { checkpointPath: input.character.preferredCheckpointPath.trim() }
      : {}),
    characterLoras: (input.character.characterLoras ?? []).map((lora) => ({ ...lora })),
    referenceState: input.referenceState ?? "none",
  };
}

export function buildShiryuGenGenerationPolicy(input: {
  spec: ShiryuGenGenerationSpec;
  character: ShiryuGenCharacterKit;
}): ShiryuGenGenerationPolicy {
  const { spec, character } = input;
  const firstReference = spec.scene.mode === FIRST_REFERENCE_MODE;
  const allowVisibleMagic = spec.continuity.visibleMagic === "allowed";
  const requiredConcepts = firstReference
    ? firstReferenceRequiredConcepts(spec)
    : unique([
        spec.identity.species,
        spec.identity.presentation === "other"
          ? "androgynous presentation"
          : spec.identity.presentation,
        `${spec.identity.age}-year-old`,
        spec.identity.lifeStage === "young-adult" ? "young adult" : "adult",
        ...splitConceptText(spec.appearance.visualTraits),
        ...splitConceptText(spec.outfit.exactDetails || spec.outfit.name),
        ...extractPositiveCanonConcepts(character.canonicalRules),
        ...sceneModeConcepts(spec),
      ]);

  const forbiddenConcepts = unique([
    ...(firstReference ? firstReferenceForbidden(spec) : []),
    ...(spec.identity.age >= 18 ? ["underage-appearance"] : []),
    ...(spec.identity.presentation === "male" ? ["female-presentation"] : []),
    ...(spec.identity.presentation === "female" ? ["male-presentation"] : []),
    ...(normalize(spec.identity.species) === "human" ? ["animal-traits"] : []),
    ...(allowVisibleMagic ? [] : ["visible-magic"]),
    ...(/\b(?:raven[- ]black|black) hair\b/i.test(spec.appearance.visualTraits)
      ? ["blond hair", "blonde hair", "white hair", "silver hair", "red hair"]
      : []),
    ...extractKnownCanonForbiddenGroups(character.canonicalRules, { allowVisibleMagic }),
    ...extractNegatedCanonPhrases(character.canonicalRules, { allowVisibleMagic }),
  ]);

  const optionalConcepts = firstReference
    ? []
    : unique([
        spec.scene.userPrompt,
        spec.series.title,
        spec.series.styleRules,
        ...(spec.continuity.storyPhase ? [`story phase: ${spec.continuity.storyPhase}`] : []),
      ]);

  const tags = requiredTags(spec);
  const forbiddenTags = unique([
    ...(spec.identity.presentation === "male" ? ["1girl"] : []),
    ...(spec.identity.presentation === "female" ? ["1boy"] : []),
  ]);
  const renderProfile = resolveShiryuGenModelProfile({
    model: spec.model,
    ...(spec.checkpointPath ? { checkpointPath: spec.checkpointPath } : {}),
  });

  return {
    version: SHIRYUGEN_GENERATION_POLICY_VERSION,
    requiredConcepts,
    optionalConcepts,
    forbiddenConcepts,
    requiredTags: tags,
    optionalTags: [],
    forbiddenTags,
    renderProfile,
    validationRules: [
      {
        id: "identity",
        label: "Identity",
        description: "Structured presentation and species must remain unchanged.",
      },
      {
        id: "outfit",
        label: "Outfit",
        description: "Required outfit details and accessories must remain represented.",
      },
      { id: "age", label: "Age", description: "Student identities must remain adult (18+)." },
      {
        id: "continuity",
        label: "Continuity",
        description: "Current power state controls whether visible magic is permitted.",
      },
      {
        id: "scene",
        label: "Scene",
        description: "Scene mode framing and required shot concepts must remain represented.",
      },
      {
        id: "model",
        label: "Model",
        description: "The character-specific checkpoint profile and LoRA stack are explicit.",
      },
    ],
  };
}
