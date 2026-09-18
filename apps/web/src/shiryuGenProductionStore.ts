import type { EnvironmentId, LocalImageModel } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { migrateGenerationIdentity, type ShiryuGenGenerationIdentity } from "./shiryuGenIdentity";
import type { ShiryuGenSceneMode } from "./shiryuGenGenerationPolicy";

import { resolveStorage } from "./lib/storage";

export type ShiryuGenAssetStatus = "draft" | "approved" | "canon" | "rejected";
export type ShiryuGenCharacterStatus = "draft" | "active" | "archived";
export type ShiryuGenConsistencyStrategy =
  | "auto"
  | "canon-reference"
  | "character-lora"
  | "ipadapter"
  | "advanced";
export type ShiryuGenReferencePurpose = "primary" | "identity" | "pose" | "style" | "controlnet";

export interface ShiryuGenCharacterLora {
  id: string;
  name: string;
  path: string;
  weight: number;
  enabled: boolean;
}

export interface ShiryuGenGenerationReferenceInput {
  assetId: string;
  attachmentId?: string;
  purpose: ShiryuGenReferencePurpose;
  status: Extract<ShiryuGenAssetStatus, "canon" | "approved">;
}

export interface ShiryuGenCharacterGenerationIntent {
  id: string;
  seriesId: string;
  characterId: string;
  characterName: string;
  outfit: string;
  scenePrompt: string;
  sceneMode: ShiryuGenSceneMode;
  prompt: string;
  requestText: string;
  consistencyStrategy: ShiryuGenConsistencyStrategy;
  /** Structured for future multi-reference IPAdapter/pose/style/ControlNet compilation. */
  references: ShiryuGenGenerationReferenceInput[];
  /** Current img2img execution uses only the primary reference. */
  referenceAssetId?: string;
  referenceAttachmentId?: string;
  checkpointPath?: string;
  model?: LocalImageModel;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  sampler?: string;
  scheduler?: string;
  modelProfile?: string;
  policyVersion?: string;
  promptWarnings?: string[];
  formatterModel?: string;
  formatterFallback?: boolean;
  firstCanonReference?: boolean;
  loras?: ShiryuGenCharacterLora[];
  createdAt: string;
}

export interface ShiryuGenReferenceAsset {
  id: string;
  name: string;
  source: string;
  status: ShiryuGenAssetStatus;
  sourceKind?: "external" | "chat-attachment";
  environmentId?: EnvironmentId;
  attachmentId?: string;
  savedPath?: string;
  generationPrompt?: string;
  generationTool?: string;
  purpose?: ShiryuGenReferencePurpose;
  createdAt: string;
}

export interface ShiryuGenCharacterKit {
  id: string;
  seriesId: string;
  name: string;
  role: string;
  description: string;
  visualTraits: string;
  canonicalRules: string;
  outfits: string[];
  status: ShiryuGenCharacterStatus;
  referenceAssets: ShiryuGenReferenceAsset[];
  generationIdentity?: ShiryuGenGenerationIdentity;
  outfitDetails?: Record<string, string>;
  /** Optional per-character generation defaults. Missing fields mean inherit global ShiryuGen settings. */
  preferredCheckpointPath?: string;
  preferredCheckpointName?: string;
  characterLoras?: ShiryuGenCharacterLora[];
  preferredConsistencyStrategy?: ShiryuGenConsistencyStrategy;
  createdAt: string;
  updatedAt: string;
}

export interface ShiryuGenSeries {
  id: string;
  title: string;
  description: string;
  styleRules: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateSeriesInput {
  title: string;
  description?: string;
  styleRules?: string;
}

interface CreateCharacterInput {
  seriesId: string;
  name: string;
  role?: string;
  description?: string;
  visualTraits?: string;
  canonicalRules?: string;
  outfits?: string[];
}

interface AddReferenceAssetInput {
  characterId: string;
  name: string;
  source: string;
  status?: ShiryuGenAssetStatus;
  sourceKind?: "external" | "chat-attachment";
  environmentId?: EnvironmentId;
  attachmentId?: string;
  savedPath?: string;
  generationPrompt?: string;
  generationTool?: string;
  purpose?: ShiryuGenReferencePurpose;
}

export interface UpdateCharacterGenerationDefaultsInput {
  preferredCheckpointPath?: string;
  preferredCheckpointName?: string;
  characterLoras?: ShiryuGenCharacterLora[];
  preferredConsistencyStrategy?: ShiryuGenConsistencyStrategy;
}

interface ShiryuGenProductionStoreState {
  series: ShiryuGenSeries[];
  characters: ShiryuGenCharacterKit[];
  activeSeriesId: string | null;
  pendingGenerationByThreadId: Record<string, ShiryuGenCharacterGenerationIntent>;
  createSeries: (input: CreateSeriesInput) => string;
  removeSeries: (seriesId: string) => void;
  setActiveSeries: (seriesId: string | null) => void;
  createCharacter: (input: CreateCharacterInput) => string;
  removeCharacter: (characterId: string) => void;
  updateCharacterIdentity: (characterId: string, identity: ShiryuGenGenerationIdentity) => void;
  updateOutfitDetails: (characterId: string, outfit: string, details: string) => void;
  setCharacterStatus: (characterId: string, status: ShiryuGenCharacterStatus) => void;
  updateCharacterGenerationDefaults: (
    characterId: string,
    input: UpdateCharacterGenerationDefaultsInput,
  ) => void;
  addReferenceAsset: (input: AddReferenceAssetInput) => string;
  removeReferenceAsset: (characterId: string, assetId: string) => void;
  setReferenceAssetStatus: (
    characterId: string,
    assetId: string,
    status: ShiryuGenAssetStatus,
  ) => void;
  queueCharacterGeneration: (threadId: string, intent: ShiryuGenCharacterGenerationIntent) => void;
  clearCharacterGeneration: (threadId: string) => void;
}

let idSequence = 0;

function createId(prefix: string): string {
  idSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSequence.toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string | undefined): string {
  return value?.trim() ?? "";
}

const ZERO_CORE_ADAPTATION_SERIES_PATTERN = /\b(?:zero core|asteria)\b/i;
const STUDENT_KIT_PATTERN =
  /\b(?:student|students|first[- ]year|academy student|academy freshman|schoolboy|schoolgirl|classmate)\b/i;
const YEAR_OLD_PATTERN = /\b(\d{1,2})(?:[- ]year[- ]old|\s+years?\s+old)\b/gi;
const AGE_LABEL_PATTERN = /\bage\s*:?\s*(\d{1,2})\b/gi;

function adultizeStudentAgeWording(value: string | undefined): string {
  return normalizeText(value)
    .replace(YEAR_OLD_PATTERN, (match, rawAge: string) => {
      const age = Number(rawAge);
      return Number.isFinite(age) && age < 18 ? "18-year-old" : match;
    })
    .replace(AGE_LABEL_PATTERN, (match, rawAge: string) => {
      const age = Number(rawAge);
      return Number.isFinite(age) && age < 18 ? "age 18" : match;
    })
    .replace(/\bteenage male\b/gi, "young adult male")
    .replace(/\bteenage female\b/gi, "young adult female")
    .replace(/\bteenage boy\b/gi, "young adult male")
    .replace(/\bteenage girl\b/gi, "young adult female")
    .replace(/\bteenager\b/gi, "young adult")
    .replace(/\bteenage\b/gi, "young adult");
}

function adultizeSeriesStudentWording(value: string | undefined): string {
  const normalized = normalizeText(value);
  return STUDENT_KIT_PATTERN.test(normalized) ? adultizeStudentAgeWording(normalized) : normalized;
}

function isZeroCoreAdaptationSeries(series: ShiryuGenSeries | undefined): boolean {
  return Boolean(series && ZERO_CORE_ADAPTATION_SERIES_PATTERN.test(series.title));
}

function hasAdultAgeMention(value: string): boolean {
  const yearOldAges = [...value.matchAll(YEAR_OLD_PATTERN)].map((match) => Number(match[1]));
  const labeledAges = [...value.matchAll(AGE_LABEL_PATTERN)].map((match) => Number(match[1]));
  return [...yearOldAges, ...labeledAges].some((age) => Number.isFinite(age) && age >= 18);
}

function adultizeCharacterKit(character: ShiryuGenCharacterKit): ShiryuGenCharacterKit {
  const identity = [
    character.role,
    character.description,
    character.visualTraits,
    character.canonicalRules,
  ].join(" ");
  if (!STUDENT_KIT_PATTERN.test(identity)) return character;

  const next = {
    ...character,
    role: adultizeStudentAgeWording(character.role),
    description: adultizeStudentAgeWording(character.description),
    visualTraits: adultizeStudentAgeWording(character.visualTraits),
    canonicalRules: adultizeStudentAgeWording(character.canonicalRules),
  };
  const adultIdentity = [next.role, next.description, next.visualTraits, next.canonicalRules].join(
    " ",
  );
  if (!hasAdultAgeMention(adultIdentity)) {
    next.role = `18-year-old ${next.role || "academy student"}`;
  }
  return { ...next, outfits: next.outfits.map(adultizeStudentAgeWording) };
}

function adaptZeroCoreCharacterKit(character: ShiryuGenCharacterKit): ShiryuGenCharacterKit {
  const migratedCharacter = adultizeCharacterKit(character);
  const identity = migrateGenerationIdentity(migratedCharacter);
  const studentFacingText = [
    migratedCharacter.role,
    migratedCharacter.description,
    migratedCharacter.visualTraits,
    migratedCharacter.canonicalRules,
  ].join(" ");
  if (STUDENT_KIT_PATTERN.test(studentFacingText)) {
    identity.classification = "student";
    identity.age = Math.max(18, identity.age ?? 18);
    if (identity.lifeStage === "unspecified") identity.lifeStage = "young-adult";
  }

  if (!/^kashiro\b/i.test(migratedCharacter.name)) {
    return { ...migratedCharacter, generationIdentity: identity };
  }

  identity.presentation = "male";
  identity.species = "human";
  identity.age = 18;
  identity.lifeStage = "young-adult";
  identity.classification = "student";
  identity.visibleMagic = "none";
  const outfitDetails = { ...migratedCharacter.outfitDetails };
  for (const outfit of migratedCharacter.outfits) {
    if (/asteria.*uniform/i.test(outfit)) {
      outfitDetails[outfit] =
        "midnight-navy Asteria academy jacket, silver trim, charcoal trousers, dark boots, single cloth wrap on LEFT forearm only, right forearm and wrist unwrapped";
    }
  }

  return {
    ...migratedCharacter,
    role: adultizeStudentAgeWording(migratedCharacter.role).replace(
      /\bteen(?:age|aged)?\b/gi,
      "young adult",
    ),
    description: adultizeStudentAgeWording(migratedCharacter.description).replace(
      /\bteen(?:age|aged)?\b/gi,
      "young adult",
    ),
    visualTraits: adultizeStudentAgeWording(migratedCharacter.visualTraits)
      .replace(/\bslim wiry (?:young adult )?build\b/gi, "slim wiry young adult build")
      .replace(/\bteen(?:age|aged)? build\b/gi, "young adult build"),
    canonicalRules: adultizeStudentAgeWording(migratedCharacter.canonicalRules),
    generationIdentity: identity,
    outfitDetails,
  };
}

function normalizeOutfits(outfits: string[] | undefined): string[] {
  if (!outfits) return [];
  return [...new Set(outfits.map((outfit) => outfit.trim()).filter(Boolean))];
}

export const useShiryuGenProductionStore = create<ShiryuGenProductionStoreState>()(
  persist(
    (set, get) => ({
      series: [],
      characters: [],
      activeSeriesId: null,
      pendingGenerationByThreadId: {},
      createSeries: (input) => {
        const id = createId("series");
        const timestamp = nowIso();
        const nextSeries: ShiryuGenSeries = {
          id,
          title: normalizeText(input.title) || "Untitled Series",
          description: normalizeText(input.description),
          styleRules: normalizeText(input.styleRules),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        set((state) => ({
          series: [...state.series, nextSeries],
          activeSeriesId: id,
        }));
        return id;
      },
      removeSeries: (seriesId) =>
        set((state) => {
          const nextSeries = state.series.filter((entry) => entry.id !== seriesId);
          const nextActiveSeriesId =
            state.activeSeriesId === seriesId ? (nextSeries[0]?.id ?? null) : state.activeSeriesId;
          return {
            series: nextSeries,
            characters: state.characters.filter((character) => character.seriesId !== seriesId),
            activeSeriesId: nextActiveSeriesId,
          };
        }),
      setActiveSeries: (seriesId) => {
        if (seriesId !== null && !get().series.some((entry) => entry.id === seriesId)) return;
        set({ activeSeriesId: seriesId });
      },
      createCharacter: (input) => {
        const id = createId("character");
        const timestamp = nowIso();
        const sourceCharacter: ShiryuGenCharacterKit = {
          id,
          seriesId: input.seriesId,
          name: normalizeText(input.name) || "Untitled Character",
          role: normalizeText(input.role),
          description: normalizeText(input.description),
          visualTraits: normalizeText(input.visualTraits),
          canonicalRules: normalizeText(input.canonicalRules),
          outfits: normalizeOutfits(input.outfits),
          status: "active",
          referenceAssets: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const parentSeries = get().series.find((series) => series.id === input.seriesId);
        const character = isZeroCoreAdaptationSeries(parentSeries)
          ? adaptZeroCoreCharacterKit(sourceCharacter)
          : { ...sourceCharacter, generationIdentity: migrateGenerationIdentity(sourceCharacter) };
        set((state) => ({ characters: [...state.characters, character] }));
        return id;
      },
      removeCharacter: (characterId) =>
        set((state) => ({
          characters: state.characters.filter((character) => character.id !== characterId),
        })),
      updateCharacterIdentity: (characterId, generationIdentity) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? { ...character, generationIdentity, updatedAt: nowIso() }
              : character,
          ),
        })),
      updateOutfitDetails: (characterId, outfit, details) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? {
                  ...character,
                  outfitDetails: { ...character.outfitDetails, [outfit]: details },
                  updatedAt: nowIso(),
                }
              : character,
          ),
        })),
      setCharacterStatus: (characterId, status) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? { ...character, status, updatedAt: nowIso() }
              : character,
          ),
        })),
      updateCharacterGenerationDefaults: (characterId, input) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? {
                  ...character,
                  preferredCheckpointPath: normalizeText(input.preferredCheckpointPath),
                  preferredCheckpointName: normalizeText(input.preferredCheckpointName),
                  characterLoras: (input.characterLoras ?? character.characterLoras ?? []).map(
                    (lora) => ({
                      ...lora,
                      name: normalizeText(lora.name) || "Character LoRA",
                      path: normalizeText(lora.path),
                      weight: Number.isFinite(lora.weight) ? lora.weight : 0.8,
                      enabled: lora.enabled !== false,
                    }),
                  ),
                  preferredConsistencyStrategy:
                    input.preferredConsistencyStrategy ??
                    character.preferredConsistencyStrategy ??
                    "auto",
                  updatedAt: nowIso(),
                }
              : character,
          ),
        })),
      addReferenceAsset: (input) => {
        const savedPath = normalizeText(input.savedPath);
        const generationPrompt = normalizeText(input.generationPrompt);
        const generationTool = normalizeText(input.generationTool);
        const attachmentId = normalizeText(input.attachmentId);
        const existingAsset = get()
          .characters.find((character) => character.id === input.characterId)
          ?.referenceAssets.find(
            (asset) =>
              input.sourceKind === "chat-attachment" &&
              asset.sourceKind === "chat-attachment" &&
              asset.environmentId === input.environmentId &&
              asset.attachmentId === input.attachmentId,
          );
        if (existingAsset) {
          set((state) => ({
            characters: state.characters.map((character) =>
              character.id === input.characterId
                ? {
                    ...character,
                    referenceAssets: character.referenceAssets.map((asset) =>
                      asset.id === existingAsset.id
                        ? {
                            ...asset,
                            name: normalizeText(input.name) || asset.name,
                            source: normalizeText(input.source) || asset.source,
                            status: input.status ?? asset.status,
                            ...(savedPath ? { savedPath } : {}),
                            ...(generationPrompt ? { generationPrompt } : {}),
                            ...(generationTool ? { generationTool } : {}),
                            ...(input.purpose ? { purpose: input.purpose } : {}),
                          }
                        : asset,
                    ),
                    updatedAt: nowIso(),
                  }
                : character,
            ),
          }));
          return existingAsset.id;
        }

        const id = createId("asset");
        const asset: ShiryuGenReferenceAsset = {
          id,
          name: normalizeText(input.name) || "Reference",
          source: normalizeText(input.source),
          status: input.status ?? "draft",
          sourceKind: input.sourceKind ?? "external",
          ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
          ...(attachmentId ? { attachmentId } : {}),
          ...(savedPath ? { savedPath } : {}),
          ...(generationPrompt ? { generationPrompt } : {}),
          ...(generationTool ? { generationTool } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
          createdAt: nowIso(),
        };
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === input.characterId
              ? {
                  ...character,
                  referenceAssets: [...character.referenceAssets, asset],
                  updatedAt: nowIso(),
                }
              : character,
          ),
        }));
        return id;
      },
      removeReferenceAsset: (characterId, assetId) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? {
                  ...character,
                  referenceAssets: character.referenceAssets.filter(
                    (asset) => asset.id !== assetId,
                  ),
                  updatedAt: nowIso(),
                }
              : character,
          ),
        })),
      setReferenceAssetStatus: (characterId, assetId, status) =>
        set((state) => ({
          characters: state.characters.map((character) =>
            character.id === characterId
              ? {
                  ...character,
                  referenceAssets: character.referenceAssets.map((asset) =>
                    asset.id === assetId ? { ...asset, status } : asset,
                  ),
                  updatedAt: nowIso(),
                }
              : character,
          ),
        })),
      queueCharacterGeneration: (threadId, intent) =>
        set((state) => ({
          pendingGenerationByThreadId: {
            ...state.pendingGenerationByThreadId,
            [threadId]: intent,
          },
        })),
      clearCharacterGeneration: (threadId) =>
        set((state) => {
          if (!state.pendingGenerationByThreadId[threadId]) return state;
          const next = { ...state.pendingGenerationByThreadId };
          delete next[threadId];
          return { pendingGenerationByThreadId: next };
        }),
    }),
    {
      name: "shiryugen:production:v1",
      version: 6,
      migrate: (persistedState) => {
        const state = persistedState as Partial<ShiryuGenProductionStoreState>;
        return {
          ...state,
          series: (state.series ?? []).map((series) =>
            isZeroCoreAdaptationSeries(series)
              ? {
                  ...series,
                  description: adultizeSeriesStudentWording(series.description),
                  styleRules: adultizeSeriesStudentWording(series.styleRules),
                }
              : series,
          ),
          characters: (state.characters ?? []).map((source) => {
            const parentSeries = state.series?.find((series) => series.id === source.seriesId);
            // Explicit ShiryuGen adaptation; original Saikin source files are never touched.
            return isZeroCoreAdaptationSeries(parentSeries)
              ? adaptZeroCoreCharacterKit(source)
              : source;
          }),
        } as ShiryuGenProductionStoreState;
      },
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        series: state.series,
        characters: state.characters,
        activeSeriesId: state.activeSeriesId,
      }),
    },
  ),
);

export function selectCharacterCoverAsset(
  character: ShiryuGenCharacterKit,
): ShiryuGenReferenceAsset | null {
  return (
    character.referenceAssets.find((asset) => asset.status === "canon") ??
    character.referenceAssets.find((asset) => asset.status === "approved") ??
    character.referenceAssets.find((asset) => asset.status === "draft") ??
    character.referenceAssets[0] ??
    null
  );
}
