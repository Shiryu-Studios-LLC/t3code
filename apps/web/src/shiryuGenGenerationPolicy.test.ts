import { describe, expect, it, vi } from "vite-plus/test";

import {
  prepareCharacterGenerationPipeline,
  prepareCharacterRendererPrompt,
  createCharacterGenerationIntent,
  buildCharacterGenerationImageInput,
} from "./shiryuGenCharacterGeneration";
import {
  containsShiryuGenConcept,
  type ShiryuGenContinuityState,
  type ShiryuGenSceneMode,
} from "./shiryuGenGenerationPolicy";
import { validateShiryuGenFormattedPrompt } from "./shiryuGenPromptValidator";
import type { ShiryuGenCharacterKit, ShiryuGenSeries } from "./shiryuGenProductionStore";

const series: ShiryuGenSeries = {
  id: "zero-core",
  title: "Zero Core",
  description: "Asteria academy progression fantasy",
  styleRules: "clean cinematic anime composition",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const kashiro: ShiryuGenCharacterKit = {
  id: "kashiro",
  seriesId: series.id,
  name: "Kashiro",
  role: "18-year-old human first-year academy student",
  description: "Young adult male protagonist with zero visible magic",
  visualTraits:
    "slightly messy layered raven-black hair, slate gray-blue eyes, slim wiry young adult build",
  canonicalRules:
    "No aura; no sparks; no runes; no glowing eyes; keep the left forearm wrap visible",
  outfits: ["Asteria first-year academy uniform"],
  outfitDetails: {
    "Asteria first-year academy uniform":
      "midnight-navy Asteria academy jacket, silver trim, charcoal trousers, dark boots, single cloth wrap on LEFT forearm only, right forearm and wrist unwrapped",
  },
  status: "active",
  referenceAssets: [],
  generationIdentity: {
    presentation: "male",
    species: "human",
    age: 18,
    lifeStage: "young-adult",
    classification: "student",
    visibleMagic: "none",
  },
  characterLoras: [],
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

const rin: ShiryuGenCharacterKit = {
  ...kashiro,
  id: "rin",
  name: "Rin",
  role: "18-year-old first-year academy student",
  description: "Young adult kitsune summoner",
  visualTraits: "silver hair, amber eyes, fox ears, fox tail",
  canonicalRules: "Keep amber eyes and fox traits",
  outfits: ["Asteria academy uniform"],
  outfitDetails: {
    "Asteria academy uniform": "navy academy jacket, silver trim, dark skirt, dark boots",
  },
  generationIdentity: {
    presentation: "female",
    species: "kitsune",
    age: 18,
    lifeStage: "young-adult",
    classification: "student",
    visibleMagic: "allowed",
  },
};

function prepare(input: {
  character?: ShiryuGenCharacterKit;
  sceneMode?: ShiryuGenSceneMode;
  scenePrompt?: string;
  continuity?: ShiryuGenContinuityState;
}) {
  return prepareCharacterGenerationPipeline({
    series,
    character: input.character ?? kashiro,
    outfit: (input.character ?? kashiro).outfits[0]!,
    sceneMode: input.sceneMode ?? "first-canon-reference",
    scenePrompt:
      input.scenePrompt ??
      "Full-body character reference, relaxed neutral three-quarter stance, Asteria stone courtyard, soft daylight",
    ...(input.continuity ? { continuity: input.continuity } : {}),
  });
}

describe("ShiryuGen deterministic generation policy", () => {
  it("prepares first references without calling AI and preserves validation", async () => {
    const format = vi.fn();
    const pipeline = prepare({});
    const result = await prepareCharacterRendererPrompt(pipeline, format);
    expect(format).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      formatterModel: "deterministic canon compiler",
      usedFallback: false,
    });
    await expect(
      prepareCharacterRendererPrompt(
        {
          ...pipeline,
          deterministic: { ...result, positivePrompt: "1girl" },
        },
        format,
      ),
    ).rejects.toThrow("Generation blocked");
    expect(format).not.toHaveBeenCalled();
  });

  it("bounds a stalled story formatter and validates its fallback", async () => {
    vi.useFakeTimers();
    try {
      const pipeline = prepare({ sceneMode: "story-scene" });
      const pending = prepareCharacterRendererPrompt(pipeline, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await pending).toMatchObject({
        usedFallback: true,
        positivePrompt: pipeline.deterministic.positivePrompt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back immediately on formatter failure for story scenes", async () => {
    const pipeline = prepare({ sceneMode: "story-scene" });
    const result = await prepareCharacterRendererPrompt(pipeline, async () => {
      throw new Error("offline");
    });
    expect(result.usedFallback).toBe(true);
    expect(result.positivePrompt).toBe(pipeline.deterministic.positivePrompt);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("drops narrative negatives and duplicate first-reference scene prose", () => {
    const pipeline = prepare({
      character: {
        ...kashiro,
        canonicalRules:
          "Never use, or be visually spoiled early. Must not be arrogant, reckless, and naturally fearless. Must not wear a white jacket. Must not show wrapped hand.",
      },
      scenePrompt: "full body, full-body, simple background, dramatic action, full body",
    });
    const { positivePrompt, negativePrompt } = pipeline.deterministic;
    expect(positivePrompt.match(/full body/g)).toHaveLength(1);
    expect(positivePrompt).not.toContain("dramatic action");
    expect(positivePrompt).toContain("(midnight-navy Asteria academy jacket:1.25)");
    expect(positivePrompt).toContain("(single cloth wrap on LEFT forearm only:1.25)");
    expect(positivePrompt).toContain("(right forearm and wrist unwrapped:1.25)");
    for (const fragment of ["use", "be visually spoiled early", "and naturally fearless"]) {
      expect(negativePrompt.split(", ")).not.toContain(fragment);
    }
    for (const conflict of [
      "white jacket",
      "white academy jacket",
      "sportswear",
      "track jacket",
      "bandaged hand",
      "wrapped hand",
      "wrapped right wrist",
      "bandaged right arm",
    ]) {
      expect(negativePrompt).toContain(conflict);
    }
    expect(pipeline.validation.errors).toEqual([]);
  });

  it("carries formatter source and fallback through the generation request", () => {
    const intent = createCharacterGenerationIntent({
      series,
      character: kashiro,
      outfit: kashiro.outfits[0]!,
      scenePrompt: "first reference",
      sceneMode: "first-canon-reference",
    });
    const request = buildCharacterGenerationImageInput("thread-1" as never, intent);
    expect(request.shiryuGenMetadata).toMatchObject({
      promptSource: "deterministic",
      formatterModel: "deterministic canon compiler",
      formatterFallback: false,
    });
    expect(request.loras).toEqual([]);
  });

  it("locks Kashiro's first reference to adult human male canon with no visible magic", () => {
    const prepared = prepare({});

    expect(prepared.policy.requiredTags).toEqual(["1boy", "solo"]);
    expect(prepared.policy.requiredConcepts).toEqual(
      expect.arrayContaining([
        "human",
        "male",
        "18-year-old",
        "young adult",
        "slim wiry young adult build",
        "slightly messy layered raven-black hair",
        "slate gray-blue eyes",
        "single cloth wrap on LEFT forearm only",
        "right forearm and wrist unwrapped",
        "full body",
        "entire head and footwear visible",
        "relaxed neutral three-quarter stance",
        "Asteria stone courtyard",
        "soft daylight",
      ]),
    );
    expect(prepared.policy.forbiddenConcepts).toEqual(
      expect.arrayContaining([
        "visible-magic",
        "animal-traits",
        "female-presentation",
        "underage-appearance",
        "chibi",
        "duplicate-character",
        "split-layout",
        "extreme-camera",
      ]),
    );
    expect(prepared.validation.errors).toEqual([]);
    expect(prepared.validation.valid).toBe(true);
    expect(containsShiryuGenConcept(prepared.deterministic.positivePrompt, "visible-magic")).toBe(
      false,
    );
    expect(
      containsShiryuGenConcept(prepared.deterministic.positivePrompt, "female-presentation"),
    ).toBe(false);
    expect(prepared.deterministic.positivePrompt).not.toMatch(/\b(?:teenager|teenage|preteen)\b/i);
  });

  it("keeps an adult female student's presentation and moves male contradictions negative", () => {
    const prepared = prepare({ character: rin });

    expect(prepared.policy.requiredTags).toEqual(["1girl", "solo"]);
    expect(prepared.policy.forbiddenConcepts).toContain("male-presentation");
    expect(prepared.policy.forbiddenConcepts).not.toContain("animal-traits");
    expect(prepared.deterministic.positivePrompt).toContain("18-year-old");
    expect(prepared.deterministic.positivePrompt).toContain("female");
    expect(prepared.deterministic.positivePrompt).toContain("fox ears");
    expect(prepared.deterministic.negativePrompt).toContain("1boy");
    expect(prepared.validation.valid).toBe(true);
  });

  it("does not globally strip magic when the character and continuity allow it", () => {
    const prepared = prepare({
      character: rin,
      sceneMode: "magic-showcase",
      scenePrompt: "Rin holding a controlled blue foxfire magic aura in one hand",
    });

    expect(prepared.policy.forbiddenConcepts).not.toContain("visible-magic");
    expect(containsShiryuGenConcept(prepared.deterministic.positivePrompt, "visible-magic")).toBe(
      true,
    );
    expect(prepared.validation.valid).toBe(true);
  });

  it("moves visible magic from forbidden to allowed when story continuity explicitly changes", () => {
    const awakened = prepare({
      sceneMode: "magic-showcase",
      scenePrompt: "Kashiro with a controlled energy aura around one hand",
      continuity: {
        storyPhase: "post-awakening",
        powerState: "awakened",
        allowVisibleMagicOverride: true,
      },
    });

    expect(awakened.spec.continuity.visibleMagic).toBe("allowed");
    expect(awakened.policy.forbiddenConcepts).not.toContain("visible-magic");
    expect(containsShiryuGenConcept(awakened.deterministic.positivePrompt, "visible-magic")).toBe(
      true,
    );
    expect(awakened.validation.valid).toBe(true);
  });

  it("blocks magic-showcase mode while baseline continuity forbids visible magic", () => {
    const baseline = prepare({
      sceneMode: "magic-showcase",
      scenePrompt: "Kashiro standing in the courtyard",
    });

    expect(baseline.validation.valid).toBe(false);
    expect(baseline.validation.errors.join(" ")).toMatch(/magic showcase.*unavailable/i);
  });

  it("keeps comma-separated negative canon constraints out of the positive prompt", () => {
    const prepared = prepare({
      character: {
        ...kashiro,
        canonicalRules:
          "Kashiro must not display sparks, elemental effects, magical HUD. Keep the left forearm wrap visible.",
      },
      sceneMode: "story-scene",
      scenePrompt: "Kashiro standing quietly in the Asteria courtyard",
    });

    expect(prepared.validation.valid).toBe(true);
    expect(prepared.deterministic.positivePrompt).not.toMatch(
      /sparks|elemental effects|magical HUD/i,
    );
    expect(prepared.deterministic.negativePrompt).toMatch(/sparks/i);
    expect(prepared.deterministic.negativePrompt).toMatch(/elemental effects/i);
    expect(prepared.deterministic.negativePrompt).toMatch(/magical HUD/i);
  });

  it("blocks formatter output that changes age or adds a forbidden current-state concept", () => {
    const prepared = prepare({});
    const invalid = validateShiryuGenFormattedPrompt({
      spec: prepared.spec,
      policy: prepared.policy,
      formatted: {
        positivePrompt: `${prepared.deterministic.positivePrompt}, 16-year-old, magic aura`,
        negativePrompt: prepared.deterministic.negativePrompt,
        warnings: [],
      },
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join(" ")).toMatch(/changed the character age/i);
    expect(invalid.errors.join(" ")).toMatch(/forbidden concept/i);
  });

  it("blocks formatter output that drops required identity or outfit concepts", () => {
    const prepared = prepare({});
    const invalid = validateShiryuGenFormattedPrompt({
      spec: prepared.spec,
      policy: prepared.policy,
      formatted: {
        positivePrompt: "1boy, solo, human, 18-year-old, young adult",
        negativePrompt: prepared.deterministic.negativePrompt,
        warnings: [],
      },
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join(" ")).toMatch(
      /missing required identity|missing required outfit|dropped required concepts/i,
    );
  });

  it("blocks formatter output that negates required canon or drops policy safeguards", () => {
    const prepared = prepare({});
    const contradictsCanon = validateShiryuGenFormattedPrompt({
      spec: prepared.spec,
      policy: prepared.policy,
      formatted: {
        positivePrompt: prepared.deterministic.positivePrompt,
        negativePrompt: `${prepared.deterministic.negativePrompt}, human`,
        warnings: [],
      },
    });
    expect(contradictsCanon.valid).toBe(false);
    expect(contradictsCanon.errors.join(" ")).toMatch(
      /negative prompt contradicts required canon/i,
    );

    const dropsSafeguards = validateShiryuGenFormattedPrompt({
      spec: prepared.spec,
      policy: prepared.policy,
      formatted: {
        positivePrompt: prepared.deterministic.positivePrompt,
        negativePrompt: "worst quality, low quality",
        warnings: [],
      },
    });
    expect(dropsSafeguards.valid).toBe(false);
    expect(dropsSafeguards.errors.join(" ")).toMatch(
      /negative prompt dropped required safeguards/i,
    );
  });

  it("marks intentional deterministic compilation as validated without fallback", () => {
    const prepared = prepare({});

    expect(prepared.deterministic.usedFallback).toBe(false);
    expect(prepared.validation.valid).toBe(true);
    expect(prepared.deterministic.positivePrompt).toContain("midnight-navy Asteria academy jacket");
    expect(prepared.deterministic.negativePrompt).toContain("magic aura");
  });
});
