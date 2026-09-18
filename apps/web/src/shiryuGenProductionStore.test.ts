import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { useShiryuGenProductionStore } from "./shiryuGenProductionStore";

function resetStore() {
  useShiryuGenProductionStore.setState({
    series: [],
    characters: [],
    activeSeriesId: null,
  });
}

afterEach(resetStore);

describe("ShiryuGen production store", () => {
  it("stores generated chat attachments as durable character references", () => {
    const store = useShiryuGenProductionStore.getState();
    const seriesId = store.createSeries({ title: "Asteria" });
    const characterId = useShiryuGenProductionStore.getState().createCharacter({
      seriesId,
      name: "Rin",
    });

    useShiryuGenProductionStore.getState().addReferenceAsset({
      characterId,
      name: "rin-portrait.png",
      source: "https://preview.invalid/rin.png",
      status: "approved",
      sourceKind: "chat-attachment",
      environmentId: EnvironmentId.make("env-local"),
      attachmentId: "generated-rin-1",
      savedPath: "/tmp/rin-portrait.png",
      generationPrompt: "Rin portrait",
      generationTool: "local-image-generation",
    });

    const asset = useShiryuGenProductionStore.getState().characters[0]?.referenceAssets[0];
    expect(asset).toMatchObject({
      name: "rin-portrait.png",
      status: "approved",
      sourceKind: "chat-attachment",
      environmentId: "env-local",
      attachmentId: "generated-rin-1",
      savedPath: "/tmp/rin-portrait.png",
      generationPrompt: "Rin portrait",
      generationTool: "local-image-generation",
    });
  });

  it("updates an existing generated reference instead of duplicating it", () => {
    const seriesId = useShiryuGenProductionStore.getState().createSeries({ title: "Asteria" });
    const characterId = useShiryuGenProductionStore.getState().createCharacter({
      seriesId,
      name: "Rin",
    });
    const environmentId = EnvironmentId.make("env-local");

    const firstAssetId = useShiryuGenProductionStore.getState().addReferenceAsset({
      characterId,
      name: "rin.png",
      source: "https://preview.invalid/old.png",
      status: "approved",
      sourceKind: "chat-attachment",
      environmentId,
      attachmentId: "generated-rin-1",
    });
    const secondAssetId = useShiryuGenProductionStore.getState().addReferenceAsset({
      characterId,
      name: "rin-canon.png",
      source: "https://preview.invalid/new.png",
      status: "canon",
      sourceKind: "chat-attachment",
      environmentId,
      attachmentId: "generated-rin-1",
    });

    const references = useShiryuGenProductionStore.getState().characters[0]?.referenceAssets ?? [];
    expect(secondAssetId).toBe(firstAssetId);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      id: firstAssetId,
      name: "rin-canon.png",
      source: "https://preview.invalid/new.png",
      status: "canon",
    });
  });

  it("adultizes under-18 Asteria student wording without changing non-age canon", () => {
    const seriesId = useShiryuGenProductionStore.getState().createSeries({ title: "Asteria" });
    useShiryuGenProductionStore.getState().createCharacter({
      seriesId,
      name: "Kashiro",
      role: "16-year-old human first-year academy student",
      description: "Teenage male protagonist with zero magic",
      visualTraits: "slightly messy raven-black hair, slim teenage build",
      canonicalRules: "No aura; no glowing eyes; left forearm wrap visible",
      outfits: ["Asteria first-year academy uniform"],
    });

    expect(useShiryuGenProductionStore.getState().characters[0]).toMatchObject({
      role: "18-year-old human first-year academy student",
      description: "young adult male protagonist with zero magic",
      visualTraits: "slightly messy raven-black hair, slim young adult build",
      canonicalRules: "No aura; no glowing eyes; left forearm wrap visible",
      outfits: ["Asteria first-year academy uniform"],
    });
  });

  it("defaults student kits with no stated age to 18+", () => {
    const seriesId = useShiryuGenProductionStore.getState().createSeries({ title: "Asteria" });
    useShiryuGenProductionStore.getState().createCharacter({
      seriesId,
      name: "Rin",
      role: "Main heroine",
      description: "Kitsune academy student",
    });

    expect(useShiryuGenProductionStore.getState().characters[0]?.role).toBe(
      "18-year-old Main heroine",
    );
  });

  it("preserves existing adult mentor ages", () => {
    const seriesId = useShiryuGenProductionStore.getState().createSeries({ title: "Asteria" });
    useShiryuGenProductionStore.getState().createCharacter({
      seriesId,
      name: "Oran",
      role: "34-year-old academy mentor",
      description: "Adult instructor",
    });

    expect(useShiryuGenProductionStore.getState().characters[0]?.role).toBe(
      "34-year-old academy mentor",
    );
  });
});

it("migrates the Zero Core adaptation and preserves original and unrelated series data", async () => {
  const store = useShiryuGenProductionStore.getState();
  const seriesId = store.createSeries({
    title: "Zero Core",
    description: "16-year-old Asteria students",
    styleRules: "Teenage students, age: 16",
  });
  const characterId = store.createCharacter({
    seriesId,
    name: "Kashiro",
    role: "first-year student",
    outfits: ["Asteria first-year academy uniform"],
  });
  const source = useShiryuGenProductionStore.getState();
  const { generationIdentity: _identity, ...legacy } = source.characters.find(
    (kit) => kit.id === characterId,
  )!;
  const persisted = {
    series: [
      ...source.series,
      { ...source.series[0]!, id: "unrelated", title: "Other", styleRules: "16-year-old" },
    ],
    characters: [{ ...legacy, role: "16-year-old first-year student" }],
  };
  const migrate = useShiryuGenProductionStore.persist.getOptions().migrate!;
  const migrated = (await migrate(persisted, 3)) as typeof source;
  expect(migrated.characters[0]?.generationIdentity).toMatchObject({
    presentation: "male",
    species: "human",
    age: 18,
    classification: "student",
    visibleMagic: "none",
  });
  expect(migrated.characters[0]?.outfitDetails?.[legacy.outfits[0]!]).toContain(
    "single cloth wrap on LEFT forearm only",
  );
  expect(migrated.series[0]?.styleRules).toBe("young adult students, age 18");
  expect(migrated.series[1]?.styleRules).toBe("16-year-old");
  expect(persisted.characters[0]?.role).toBe("16-year-old first-year student");
  expect(useShiryuGenProductionStore.persist.getOptions().version).toBe(6);
  expect(await migrate(migrated, 5)).toEqual(migrated);
});

it("keeps an explicit generation identity independent from descriptive prose", () => {
  const store = useShiryuGenProductionStore.getState();
  const seriesId = store.createSeries({ title: "Test" });
  const id = store.createCharacter({
    seriesId,
    name: "Rin",
    description: "Accompanies a male protagonist",
  });
  store.updateCharacterIdentity(id, {
    presentation: "female",
    species: "kitsune",
    age: 20,
    lifeStage: "adult",
    classification: "student",
    visibleMagic: "allowed",
  });
  expect(
    useShiryuGenProductionStore.getState().characters[0]?.generationIdentity?.presentation,
  ).toBe("female");
});
