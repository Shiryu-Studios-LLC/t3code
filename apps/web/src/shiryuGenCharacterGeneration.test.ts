import { describe, expect, it } from "vite-plus/test";

import {
  buildCharacterGenerationImageInput,
  buildCharacterGenerationNegativePrompt,
  buildCharacterGenerationPrompt,
  createCharacterGenerationIntent,
  inferCharacterImageModel,
  selectableCharacterReferences,
  selectedCharacterLoras,
  validateFirstCanonPrompt,
} from "./shiryuGenCharacterGeneration";
import { containsShiryuGenConcept } from "./shiryuGenGenerationPolicy";
import type {
  ShiryuGenCharacterKit,
  ShiryuGenReferenceAsset,
  ShiryuGenSeries,
} from "./shiryuGenProductionStore";

const series: ShiryuGenSeries = {
  id: "series-1",
  title: "Asteria",
  description: "Academy fantasy",
  styleRules: "cinematic anime lighting",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const canon: ShiryuGenReferenceAsset = {
  id: "canon-1",
  name: "Canon portrait",
  source: "/preview/rin.png",
  sourceKind: "chat-attachment",
  environmentId: "env-1" as never,
  attachmentId: "attachment-rin",
  status: "canon",
  createdAt: "2026-09-15T00:00:00.000Z",
};

const approved: ShiryuGenReferenceAsset = {
  ...canon,
  id: "approved-1",
  name: "Approved full body",
  status: "approved",
  createdAt: "2026-09-15T01:00:00.000Z",
};

const character: ShiryuGenCharacterKit = {
  id: "character-1",
  seriesId: series.id,
  name: "Rin",
  generationIdentity: {
    presentation: "female",
    species: "kitsune",
    age: 18,
    lifeStage: "young-adult",
    classification: "student",
    visibleMagic: "allowed",
  },
  role: "Main heroine",
  description: "Kitsune student",
  visualTraits: "silver hair, amber eyes, fox ears",
  canonicalRules: "Keep facial markings and eye color unchanged",
  outfits: ["Academy Uniform"],
  status: "active",
  referenceAssets: [approved, canon, { ...canon, id: "rejected", status: "rejected" }],
  preferredCheckpointPath: "/models/anime-xl.safetensors",
  characterLoras: [
    {
      id: "rin-lora",
      name: "Rin identity",
      path: "/models/loras/rin.safetensors",
      weight: 0.85,
      enabled: true,
    },
  ],
  preferredConsistencyStrategy: "auto",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

describe("ShiryuGen character generation", () => {
  it("selects only saved enabled LoRAs with a path and preserves weights", () => {
    const kit = {
      ...character,
      characterLoras: [
        ...character.characterLoras!,
        { id: "off", name: "off", path: "/off.safetensors", weight: 1, enabled: false },
        { id: "empty", name: "empty", path: " ", weight: 1, enabled: true },
      ],
    };
    expect(selectedCharacterLoras(kit, "auto")).toEqual(character.characterLoras);
    expect(selectedCharacterLoras(kit, "character-lora")).toEqual(character.characterLoras);
    expect(selectedCharacterLoras(kit, "canon-reference")).toEqual([]);
    expect(() =>
      createCharacterGenerationIntent({
        series,
        character: { ...character, characterLoras: [] },
        outfit: "Academy Uniform",
        scenePrompt: "standing",
        strategy: "character-lora",
      }),
    ).toThrow("at least one enabled LoRA");
  });

  it("orders Canon ahead of Approved and excludes rejected references", () => {
    expect(selectableCharacterReferences(character).map((asset) => asset.id)).toEqual([
      "canon-1",
      "approved-1",
    ]);
  });

  it("compiles series, identity, canon, outfit and scene context without flattening reference metadata into CLIP", () => {
    const prompt = buildCharacterGenerationPrompt({
      series,
      character,
      outfit: "Academy Uniform",
      scenePrompt: "standing on a rooftop in the rain",
      reference: canon,
    });
    expect(prompt).toContain("Asteria");
    expect(prompt).toContain("silver hair, amber eyes, fox ears");
    expect(prompt).toContain("Keep facial markings and eye color unchanged");
    expect(prompt).toContain("Academy Uniform");
    expect(prompt).not.toContain("Canon portrait (canon)");
    expect(prompt).toContain("standing on a rooftop in the rain");
  });

  it("Auto uses supported durable reference, checkpoint and character LoRA together", () => {
    const intent = createCharacterGenerationIntent({
      series,
      character,
      outfit: "Academy Uniform",
      scenePrompt: "standing on a rooftop in the rain",
      reference: canon,
      strategy: "auto",
    });
    expect(intent.referenceAttachmentId).toBe("attachment-rin");
    expect(intent.checkpointPath).toBe("/models/anime-xl.safetensors");
    expect(intent.loras?.[0]).toMatchObject({
      path: "/models/loras/rin.safetensors",
      weight: 0.85,
    });
  });

  it("maps a Character Kit intent into the normal local-image RPC input", () => {
    const intent = createCharacterGenerationIntent({
      series,
      character,
      outfit: "Academy Uniform",
      scenePrompt: "standing on a rooftop in the rain",
      reference: canon,
      strategy: "auto",
    });
    const imageInput = buildCharacterGenerationImageInput("thread-rin" as never, intent);

    expect(imageInput).toMatchObject({
      threadId: "thread-rin",
      prompt: intent.prompt,
      requestText: intent.requestText,
      referenceAttachmentId: "attachment-rin",
      checkpointPath: "/models/anime-xl.safetensors",
      loras: [{ name: "Rin identity", path: "/models/loras/rin.safetensors", weight: 0.85 }],
    });
  });

  it("routes character checkpoints from the character identity instead of unrelated series lore", () => {
    const { preferredCheckpointPath: _preferredCheckpointPath, ...characterWithoutCheckpoint } =
      character;
    const kashiro: ShiryuGenCharacterKit = {
      ...characterWithoutCheckpoint,
      id: "character-kashiro",
      name: "Kashiro",
      generationIdentity: {
        presentation: "male",
        species: "human",
        age: 18,
        lifeStage: "young-adult",
        classification: "student",
        visibleMagic: "none",
      },
      outfitDetails: {
        "Asteria first-year academy uniform":
          "midnight-navy jacket, silver trim, charcoal trousers, dark boots, left forearm cloth wrap",
      },
      role: "18-year-old human first-year academy student",
      description: "Human young adult male protagonist with zero magical power",
      visualTraits:
        "slightly messy raven-black hair, slate gray-blue eyes, slim wiry build, left forearm wrap visible",
      canonicalRules:
        "Zero magic; no aura; no glowing eyes; no spell circles; no runes; no floating sigils; left forearm wrap visible",
      referenceAssets: [],
      characterLoras: [],
    };

    expect(inferCharacterImageModel(kashiro)).toBe("nova-anime");
    expect(inferCharacterImageModel(character)).toBe("nova-furry");

    const intent = createCharacterGenerationIntent({
      series: {
        ...series,
        description: "Academy fantasy featuring a kitsune heroine and fox-spirit lore",
      },
      character: kashiro,
      outfit: "Asteria first-year academy uniform",
      scenePrompt:
        "Full-body character reference of Kashiro standing in a relaxed neutral pose, slight three-quarter angle.",
      strategy: "auto",
    });

    expect(intent.model).toBe("nova-anime");
    expect(intent.firstCanonReference).toBe(true);
    expect(intent.width).toBe(768);
    expect(intent.height).toBe(1024);
    expect(intent.steps).toBe(26);
    expect(intent.negativePrompt).toContain("furry");
    expect(intent.negativePrompt).toContain("comic page");
    expect(intent.negativePrompt).toContain("female");
    expect(intent.negativePrompt).toContain("blonde hair");
    expect(intent.prompt).toContain("1boy");
    expect(intent.prompt).toContain("solo");
    expect(intent.prompt).toContain("human");
    expect(intent.prompt).toContain("male");
    expect(intent.prompt).toContain("18-year-old");
    expect(intent.prompt).toContain("young adult");
    expect(intent.prompt).toContain("slim wiry young adult build");
    expect(intent.prompt).toContain("slightly messy layered raven-black hair");
    expect(intent.prompt).toContain("slate gray-blue eyes");
    expect(containsShiryuGenConcept(intent.prompt, "visible-magic")).toBe(false);
    expect(containsShiryuGenConcept(intent.prompt, "animal-traits")).toBe(false);
    expect(intent.prompt).toContain("single cloth wrap on LEFT forearm only");
    expect(intent.prompt).toContain("right forearm and wrist unwrapped");
    expect(intent.prompt).toContain(
      "(midnight-navy Asteria academy jacket:1.25), silver trim, charcoal trousers, dark boots",
    );
    expect(intent.negativePrompt).toContain("magic circle");
    expect(intent.negativePrompt).toContain("child");
    expect(intent.negativePrompt).toContain("underage");
    expect(intent.negativePrompt).toContain("preteen");
    expect(intent.negativePrompt).toContain("young child");
    expect(intent.negativePrompt).toContain("middle schooler");
    expect(intent.prompt).toContain("2D Japanese anime");
    expect(intent.prompt).toContain("entire head and footwear visible");
    expect(intent.prompt).toContain("relaxed neutral three-quarter stance");
    expect(intent.prompt).not.toContain("teenager");
    expect(intent.prompt).not.toContain("16-year-old");

    const imageInput = buildCharacterGenerationImageInput("thread-kashiro" as never, intent);
    expect(imageInput.model).toBe("nova-anime");
    expect(imageInput.negativePrompt).toContain("animal ears");
    expect(imageInput.loras).toEqual([]);
    expect(imageInput).toMatchObject({ width: 768, height: 1024, steps: 26, guidance: 4.5 });
  });

  it("keeps animal traits available for explicitly non-human character kits", () => {
    const negativePrompt = buildCharacterGenerationNegativePrompt(character, true);
    expect(negativePrompt).not.toContain("animal ears");
    expect(negativePrompt).toContain("split panel");
  });

  it("does not fake an unsupported IPAdapter workflow", () => {
    expect(() =>
      createCharacterGenerationIntent({
        series,
        character,
        outfit: "Academy Uniform",
        scenePrompt: "portrait",
        reference: canon,
        strategy: "ipadapter",
      }),
    ).toThrow(/not executable yet/i);
  });
});

it("requires explicit identity before spending a first-reference generation", () => {
  const { generationIdentity: _identity, ...legacy } = character;
  expect(() =>
    createCharacterGenerationIntent({
      series,
      character: legacy,
      outfit: "Uniform",
      scenePrompt: "Full-body character reference, courtyard",
    }),
  ).toThrow(/generation identity/);
});
it("keeps first-reference mode with an existing Canon image and excludes lore", () => {
  const intent = createCharacterGenerationIntent({
    series: { ...series, description: "summoning dragons", styleRules: "glowing energy" },
    character,
    outfit: "Uniform",
    scenePrompt: "Full-body character reference, courtyard, daylight",
    reference: canon,
  });
  expect(intent.firstCanonReference).toBe(true);
  expect(intent.referenceAttachmentId).toBeUndefined();
  expect(intent.model).toBe("custom");
  expect(intent.prompt).toContain("1girl, solo, kitsune");
  expect(intent.prompt).toContain("Asteria stone courtyard, soft daylight");
  expect(intent.prompt).not.toMatch(/summoning|dragons|glowing energy|Main heroine/);
  expect(intent.negativePrompt).not.toContain("animal ears");
});
it("fails preflight for a missing sex tag or positive magic contradiction", () => {
  const kit = {
    ...character,
    generationIdentity: {
      ...character.generationIdentity!,
      presentation: "male" as const,
      visibleMagic: "none" as const,
    },
  };
  expect(() => validateFirstCanonPrompt(kit, "1person, solo")).toThrow(/presentation/);
  expect(() => validateFirstCanonPrompt(kit, "1boy, glowing eyes")).toThrow(/magic/);
});

it("preserves decimal prompt weights in exact outfit details", () => {
  const kit = {
    ...character,
    outfitDetails: { Uniform: "navy jacket, (left forearm cloth wrap:1.15)" },
  };
  const intent = createCharacterGenerationIntent({
    series,
    character: kit,
    outfit: "Uniform",
    scenePrompt: "courtyard",
    firstCanonReference: true,
  });
  expect(intent.prompt).toContain("(left forearm cloth wrap:1.15)");
});
