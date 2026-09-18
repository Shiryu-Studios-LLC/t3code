import type { ShiryuGenInstalledModel, ShiryuGenPromptFormatResult } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ImagePlusIcon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useGeneralChatHandler } from "../../hooks/useGeneralChat";
import { usePrimarySettings } from "../../hooks/useSettings";
import {
  SHIRYUGEN_CONSISTENCY_STRATEGIES,
  createCharacterGenerationIntent,
  inferCharacterImageModel,
  prepareCharacterGenerationPipeline,
  prepareCharacterRendererPrompt,
  selectedCharacterLoras,
  selectableCharacterReferences,
} from "../../shiryuGenCharacterGeneration";
import { readInstalledCivitaiModels } from "../../shiryuGenCivitai";
import type { ShiryuGenSceneMode } from "../../shiryuGenGenerationPolicy";
import { validateShiryuGenFormattedPrompt } from "../../shiryuGenPromptValidator";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useShiryuGenProductionStore,
  type ShiryuGenAssetStatus,
  type ShiryuGenCharacterKit,
  type ShiryuGenCharacterLora,
  type ShiryuGenConsistencyStrategy,
  type ShiryuGenReferenceAsset,
  type ShiryuGenSeries,
} from "../../shiryuGenProductionStore";
import { migrateGenerationIdentity } from "../../shiryuGenIdentity";
import { ReferenceAssetPreview } from "./ReferenceAssetPreview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

interface CharacterGenerationPanelProps {
  series: ShiryuGenSeries;
  characters: ShiryuGenCharacterKit[];
  selectedCharacterId: string | null;
  onSelectedCharacterIdChange: (characterId: string) => void;
}

interface PromptPreset {
  id: string;
  label: string;
  description: string;
  mode: ShiryuGenSceneMode;
  build: (character: ShiryuGenCharacterKit, outfit: string) => string;
}

const INHERIT_CHECKPOINT = "__inherit__";
const MANUAL_CHECKPOINT = "__manual__";

const PROMPT_PRESETS: ReadonlyArray<PromptPreset> = [
  {
    id: "canon-reference",
    label: "First canon reference",
    description: "Neutral full-body image for locking identity before story scenes.",
    mode: "first-canon-reference",
    build: (character, outfit) =>
      `Full-body character reference of ${character.name}, standing in a relaxed neutral three-quarter pose with both arms resting naturally at the sides. Full body from hair to footwear, calm observant expression, entire ${outfit || "default outfit"} clearly visible. Clean Asteria stone courtyard in soft daylight, simple uncluttered background, no dramatic action or extreme camera angle.`,
  },
  {
    id: "classroom",
    label: "Classroom scene",
    description: "Natural academy-life framing with readable expression and outfit.",
    mode: "classroom-scene",
    build: (character) =>
      `${character.name} seated at a desk in an Asteria academy classroom, looking toward the front of the room with a focused, slightly thoughtful expression. Medium-wide anime shot, natural daylight from tall windows, classmates softly out of focus in the background, clear face and upper-body silhouette.`,
  },
  {
    id: "emotional-closeup",
    label: "Emotional close-up",
    description: "Face-focused shot for expression and identity testing.",
    mode: "emotional-closeup",
    build: (character) =>
      `Close-up anime portrait of ${character.name}, restrained emotional expression, eyes focused just off camera, subtle tension in the brow and mouth, soft natural academy lighting, shallow depth of field, face and hairstyle fully readable, no exaggerated expression.`,
  },
  {
    id: "action",
    label: "Action scene",
    description: "Dynamic story shot while preserving the selected character kit.",
    mode: "action-scene",
    build: (character) =>
      `${character.name} moving quickly through an academy courtyard during a tense confrontation, dynamic three-quarter action pose, cinematic anime composition, clothing and face still clearly readable, strong sense of motion without obscuring identity.`,
  },
];

function defaultLora(): ShiryuGenCharacterLora {
  return {
    id: `character-lora-${Date.now().toString(36)}`,
    name: "Character LoRA",
    path: "",
    weight: 0.8,
    enabled: true,
  };
}

function resolveInstalledAbsolutePath(root: string, relativePath: string): string {
  if (!root.trim()) return relativePath;
  const windowsStyle = root.includes("\\") && !root.includes("/");
  const separator = windowsStyle ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, "");
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function checkpointSelectionValue(
  checkpointPath: string,
  installedCheckpoints: ReadonlyArray<ShiryuGenInstalledModel>,
  root: string,
): string {
  if (!checkpointPath.trim()) return INHERIT_CHECKPOINT;
  const match = installedCheckpoints.find(
    (entry) => resolveInstalledAbsolutePath(root, entry.relativePath) === checkpointPath.trim(),
  );
  return match ? `installed:${match.modelId}:${match.versionId}` : MANUAL_CHECKPOINT;
}

function globalCheckpointLabel(checkpoint: string, customPath: string): string {
  if (checkpoint === "custom") {
    return customPath.trim() ? fileNameFromPath(customPath) : "Custom checkpoint";
  }
  const labels: Record<string, string> = {
    auto: "Automatic routing",
    "nova-unreal": "Nova Unreal XL",
    "nova-anime": "Nova Anime XL",
    "perfect-anima": "Perfect Anima AIO",
    "nova-furry": "Nova Furry XL",
    "nova-pkm": "Nova PKM XL",
    "nova-mature": "Nova Mature XL",
  };
  return labels[checkpoint] ?? checkpoint;
}

function assetStatusClass(status: ShiryuGenAssetStatus): string {
  if (status === "canon") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-300";
  if (status === "approved") return "border-blue-500/35 bg-blue-500/10 text-blue-300";
  if (status === "rejected") return "border-destructive/35 bg-destructive/10 text-destructive";
  return "border-border/70 bg-muted/30 text-muted-foreground";
}

export function CharacterGenerationPanel({
  series,
  characters,
  selectedCharacterId,
  onSelectedCharacterIdChange,
}: CharacterGenerationPanelProps) {
  const startGeneralChat = useGeneralChatHandler();
  const settings = usePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const formatShiryuGenPrompt = useAtomCommand(serverEnvironment.formatShiryuGenPrompt, {
    reportFailure: false,
  });
  const queueCharacterGeneration = useShiryuGenProductionStore(
    (state) => state.queueCharacterGeneration,
  );
  const updateCharacterGenerationDefaults = useShiryuGenProductionStore(
    (state) => state.updateCharacterGenerationDefaults,
  );
  const setReferenceAssetStatus = useShiryuGenProductionStore(
    (state) => state.setReferenceAssetStatus,
  );

  const character =
    characters.find((entry) => entry.id === selectedCharacterId) ?? characters[0] ?? null;
  const references = useMemo(
    () => (character ? selectableCharacterReferences(character) : []),
    [character],
  );

  const [outfit, setOutfit] = useState("");
  const [referenceAssetId, setReferenceAssetId] = useState<string>("");
  const [scenePrompt, setScenePrompt] = useState("");
  const [sceneMode, setSceneMode] = useState<ShiryuGenSceneMode>("first-canon-reference");
  const [strategy, setStrategy] = useState<ShiryuGenConsistencyStrategy>("auto");
  const [preparedPrompt, setPreparedPrompt] = useState<ShiryuGenPromptFormatResult | null>(null);
  const [preparedPipelineKey, setPreparedPipelineKey] = useState<string | null>(null);
  const [isPreparingPrompt, setIsPreparingPrompt] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpointPath, setCheckpointPath] = useState("");
  const [loras, setLoras] = useState<ShiryuGenCharacterLora[]>([]);
  const [installedModels, setInstalledModels] = useState<ShiryuGenInstalledModel[]>([]);
  const [installedModelsError, setInstalledModelsError] = useState<string | null>(null);

  useEffect(() => {
    if (!character) return;
    setOutfit(character.outfits[0] ?? "");
    setReferenceAssetId(selectableCharacterReferences(character)[0]?.id ?? "");
    setStrategy(character.preferredConsistencyStrategy ?? "auto");
    setCheckpointName(character.preferredCheckpointName ?? "");
    setCheckpointPath(character.preferredCheckpointPath ?? "");
    setLoras((character.characterLoras ?? []).map((lora) => ({ ...lora })));
    setSceneMode(
      selectableCharacterReferences(character).length === 0
        ? "first-canon-reference"
        : "story-scene",
    );
    setPreparedPrompt(null);
    setPreparedPipelineKey(null);
    setError(null);
  }, [character?.id]);

  useEffect(() => {
    if (!character && characters[0]) {
      onSelectedCharacterIdChange(characters[0].id);
    }
  }, [character, characters, onSelectedCharacterIdChange]);

  useEffect(() => {
    let cancelled = false;
    void readInstalledCivitaiModels()
      .then((result) => {
        if (cancelled) return;
        setInstalledModels([...result.items]);
        setInstalledModelsError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setInstalledModelsError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Installed model library is unavailable.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installedCheckpoints = useMemo(
    () => installedModels.filter((entry) => entry.installTarget === "checkpoints"),
    [installedModels],
  );
  const installedLoras = useMemo(
    () => installedModels.filter((entry) => entry.installTarget === "loras"),
    [installedModels],
  );
  const checkpointSelectValue = checkpointSelectionValue(
    checkpointPath,
    installedCheckpoints,
    settings.imageGeneration.comfyUiRootDirectory,
  );

  const selectedReference =
    references.find((reference) => reference.id === referenceAssetId) ?? null;
  const firstCanonReference = sceneMode === "first-canon-reference";
  const pipelinePreview = useMemo(() => {
    if (!character || !scenePrompt.trim()) return null;
    try {
      return {
        pipeline: prepareCharacterGenerationPipeline({
          series,
          character,
          outfit,
          scenePrompt,
          sceneMode,
          reference: firstCanonReference ? null : selectedReference,
        }),
      };
    } catch (cause) {
      return {
        error:
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "The generation policy is not valid yet.",
      };
    }
  }, [character, firstCanonReference, outfit, sceneMode, scenePrompt, selectedReference, series]);
  const pipelineKey = useMemo(
    () =>
      JSON.stringify({
        characterId: character?.id ?? null,
        characterUpdatedAt: character?.updatedAt ?? null,
        outfit,
        sceneMode,
        scenePrompt,
        referenceAssetId: firstCanonReference ? null : (selectedReference?.id ?? null),
        strategy,
      }),
    [
      character?.id,
      character?.updatedAt,
      firstCanonReference,
      outfit,
      sceneMode,
      scenePrompt,
      selectedReference?.id,
      strategy,
    ],
  );
  useEffect(() => {
    setPreparedPrompt(null);
    setPreparedPipelineKey(null);
  }, [pipelineKey]);
  const preparedValidation = useMemo(() => {
    if (
      !preparedPrompt ||
      preparedPipelineKey !== pipelineKey ||
      !pipelinePreview ||
      !("pipeline" in pipelinePreview)
    ) {
      return null;
    }
    return validateShiryuGenFormattedPrompt({
      spec: pipelinePreview.pipeline.spec,
      policy: pipelinePreview.pipeline.policy,
      formatted: preparedPrompt,
    });
  }, [pipelineKey, pipelinePreview, preparedPipelineKey, preparedPrompt]);
  const rendererPromptReady = Boolean(
    preparedPrompt && preparedPipelineKey === pipelineKey && preparedValidation?.valid,
  );
  const recentGeneratedAssets = useMemo(
    () =>
      (character?.referenceAssets ?? [])
        .filter(
          (asset) =>
            asset.sourceKind === "chat-attachment" && Boolean(asset.generationPrompt?.trim()),
        )
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 8),
    [character],
  );

  const globalCheckpoint = globalCheckpointLabel(
    character ? inferCharacterImageModel(character) : "nova-anime",
    "",
  );
  const activeCheckpointLabel = checkpointPath.trim()
    ? checkpointName.trim() || fileNameFromPath(checkpointPath)
    : globalCheckpoint;
  const hasCanonReference = references.some((reference) => reference.status === "canon");
  const canGenerate = Boolean(
    scenePrompt.trim() && rendererPromptReady && !isPreparingPrompt && !isGenerating,
  );

  const saveGenerationDefaults = () => {
    if (!character) return;
    updateCharacterGenerationDefaults(character.id, {
      preferredCheckpointName: checkpointName,
      preferredCheckpointPath: checkpointPath,
      preferredConsistencyStrategy: strategy,
      characterLoras: loras,
    });
    toastManager.add({
      type: "success",
      title: "Character overrides saved",
      description:
        checkpointPath.trim() || loras.length > 0
          ? `${character.name} will use these overrides instead of the matching global defaults.`
          : `${character.name} will use automatic character routing with no global LoRAs.`,
    });
    setShowDefaults(false);
  };

  const applyPreset = (preset: PromptPreset) => {
    if (!character) return;
    setSceneMode(preset.mode);
    setScenePrompt(preset.build(character, outfit));
    setError(null);
  };

  const chooseCheckpoint = (value: string) => {
    if (value === INHERIT_CHECKPOINT) {
      setCheckpointName("");
      setCheckpointPath("");
      return;
    }
    if (value === MANUAL_CHECKPOINT) return;
    const [, modelId, versionId] = value.split(":");
    const installed = installedCheckpoints.find(
      (entry) => String(entry.modelId) === modelId && String(entry.versionId) === versionId,
    );
    if (!installed) return;
    setCheckpointName(installed.modelName);
    setCheckpointPath(
      resolveInstalledAbsolutePath(
        settings.imageGeneration.comfyUiRootDirectory,
        installed.relativePath,
      ),
    );
  };

  const addInstalledLora = (value: string) => {
    const [modelId, versionId] = value.split(":");
    const installed = installedLoras.find(
      (entry) => String(entry.modelId) === modelId && String(entry.versionId) === versionId,
    );
    if (!installed) return;
    const path = resolveInstalledAbsolutePath(
      settings.imageGeneration.comfyUiRootDirectory,
      installed.relativePath,
    );
    if (loras.some((entry) => entry.path === path)) return;
    setLoras((current) => [
      ...current,
      {
        id: `civitai-${installed.modelId}-${installed.versionId}`,
        name: installed.modelName,
        path,
        weight: 0.8,
        enabled: true,
      },
    ]);
  };

  const promoteAsset = (
    asset: ShiryuGenReferenceAsset,
    status: Extract<ShiryuGenAssetStatus, "approved" | "canon" | "rejected">,
  ) => {
    if (!character) return;
    setReferenceAssetStatus(character.id, asset.id, status);
    if (status === "approved" || status === "canon") {
      setReferenceAssetId(asset.id);
    }
  };

  const prepareRendererPrompt = async () => {
    if (!character || !scenePrompt.trim() || !pipelinePreview || !("pipeline" in pipelinePreview)) {
      setError(
        pipelinePreview && "error" in pipelinePreview
          ? pipelinePreview.error
          : "Complete the Character Kit and scene prompt before preparing the renderer prompt.",
      );
      return;
    }
    setError(null);
    setIsPreparingPrompt(true);
    try {
      const formatted = await prepareCharacterRendererPrompt(
        pipelinePreview.pipeline,
        async (input) => {
          if (!primaryEnvironmentId) throw new Error("Local environment unavailable.");
          const result = await formatShiryuGenPrompt({
            environmentId: primaryEnvironmentId,
            input,
          });
          if (result._tag !== "Success") throw new Error("Local formatter unavailable.");
          return result.value;
        },
      );
      const validation = validateShiryuGenFormattedPrompt({
        spec: pipelinePreview.pipeline.spec,
        policy: pipelinePreview.pipeline.policy,
        formatted,
      });
      setPreparedPrompt(formatted);
      setPreparedPipelineKey(pipelineKey);
      if (!validation.valid) {
        setError(`Renderer prompt validation failed: ${validation.errors.join(" ")}`);
        return;
      }
      toastManager.add({
        type: formatted.usedFallback ? "info" : "success",
        title: formatted.usedFallback
          ? "Deterministic renderer prompt ready"
          : "Renderer prompt ready",
        description: formatted.usedFallback
          ? "Local prompt formatter unavailable — using deterministic prompt."
          : `Formatted locally${formatted.formatterModel ? ` with ${formatted.formatterModel}` : ""} and validated against canon policy.`,
      });
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not prepare the renderer prompt.";
      setError(message);
    } finally {
      setIsPreparingPrompt(false);
    }
  };

  const generate = async () => {
    if (!character || !scenePrompt.trim()) return;
    if (!rendererPromptReady || !preparedPrompt) {
      setError("Prepare and validate the renderer prompt before generating.");
      return;
    }
    setError(null);
    setIsGenerating(true);
    try {
      const intent = createCharacterGenerationIntent({
        series,
        character,
        outfit,
        scenePrompt,
        sceneMode,
        reference: selectedReference,
        strategy,
        formattedPrompt: preparedPrompt,
      });
      const opened = await startGeneralChat({
        ...(!firstCanonReference && selectedReference?.environmentId
          ? { environmentId: selectedReference.environmentId }
          : {}),
      });
      if (!opened) {
        throw new Error("ShiryuGen could not open a conversation for this generation.");
      }
      queueCharacterGeneration(opened.threadId, intent);
      toastManager.add({
        type: "success",
        title: `Generating ${character.name}`,
        description:
          "The Character Kit, outfit, continuity rules, and generation settings were sent to ShiryuGen.",
      });
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Could not start character generation.";
      setError(message);
      toastManager.add({
        type: "error",
        title: "Character generation could not start",
        description: message,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  if (characters.length === 0 || !character) {
    return (
      <section className="rounded-2xl border border-dashed border-border/70 bg-muted/10 p-8 text-center">
        <SparklesIcon className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-3 font-semibold">Character Generation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add a Character Kit first, then generate with its canon rules, outfits, references, and
          model defaults.
        </p>
      </section>
    );
  }

  return (
    <section
      id="character-generation-panel"
      className="scroll-mt-20 overflow-hidden rounded-2xl border border-border/70 bg-card/45"
    >
      <div className="border-b border-border/60 bg-gradient-to-b from-muted/20 to-transparent p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <SparklesIcon className="size-3.5" /> Character Generation
            </div>
            <h2 className="mt-1 text-xl font-semibold">
              Create a consistent {character.name} image
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Describe only the scene and action. ShiryuGen automatically compiles the Character
              Kit, outfit, canon rules, checkpoint, LoRAs, and approved reference.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowDefaults((current) => !current)}
          >
            <Settings2Icon className="size-4" /> Character overrides
          </Button>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-4">
          <Step number="1" label="Character" value={character.name} active />
          <Step number="2" label="Outfit" value={outfit || "Default"} active={Boolean(outfit)} />
          <Step
            number="3"
            label="Reference"
            value={selectedReference ? selectedReference.name : "First reference"}
            active={Boolean(selectedReference)}
          />
          <Step
            number="4"
            label="Generate"
            value="Scene prompt"
            active={Boolean(scenePrompt.trim())}
          />
        </div>
      </div>

      <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <div className="space-y-5">
          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Identity
                </div>
                <div className="mt-1 text-base font-semibold">{character.name}</div>
                {character.role ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {character.role}
                  </p>
                ) : null}
              </div>
              <span className="rounded-full border border-border/70 bg-muted/25 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Character Kit
              </span>
            </div>

            <Field label="Character">
              <select
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                value={character.id}
                onChange={(event) => onSelectedCharacterIdChange(event.target.value)}
              >
                {characters.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>

            <details className="mt-4 space-y-3">
              <summary className="cursor-pointer text-sm font-medium">Generation identity</summary>
              <p className="text-xs text-muted-foreground">
                These saved fields control rendering. Check them before the first canon reference.
              </p>
              {(() => {
                const identity =
                  character.generationIdentity ?? migrateGenerationIdentity(character);
                const update = (patch: Partial<typeof identity>) =>
                  useShiryuGenProductionStore
                    .getState()
                    .updateCharacterIdentity(character.id, { ...identity, ...patch });
                return (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Presentation">
                      <select
                        className="h-10 rounded-md border bg-background px-2"
                        value={identity.presentation}
                        onChange={(e) =>
                          update({ presentation: e.target.value as typeof identity.presentation })
                        }
                      >
                        <option value="unspecified">Choose…</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </Field>
                    <Field label="Species">
                      <Input
                        value={identity.species}
                        onChange={(e) => update({ species: e.target.value })}
                      />
                    </Field>
                    <Field label="Age">
                      <Input
                        type="number"
                        min={18}
                        value={identity.age ?? ""}
                        onChange={(e) =>
                          update({ age: e.target.value === "" ? null : Number(e.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Life stage">
                      <select
                        className="h-10 rounded-md border bg-background px-2"
                        value={identity.lifeStage}
                        onChange={(e) =>
                          update({ lifeStage: e.target.value as typeof identity.lifeStage })
                        }
                      >
                        <option value="unspecified">Choose…</option>
                        <option value="young-adult">Young adult</option>
                        <option value="adult">Adult</option>
                      </select>
                    </Field>
                    <Field label="Classification">
                      <select
                        className="h-10 rounded-md border bg-background px-2"
                        value={identity.classification}
                        onChange={(e) =>
                          update({
                            classification: e.target.value as typeof identity.classification,
                          })
                        }
                      >
                        <option value="student">Student</option>
                        <option value="non-student">Non-student</option>
                      </select>
                    </Field>
                    <Field label="Visible magic">
                      <select
                        className="h-10 rounded-md border bg-background px-2"
                        value={identity.visibleMagic}
                        onChange={(e) =>
                          update({ visibleMagic: e.target.value as typeof identity.visibleMagic })
                        }
                      >
                        <option value="none">None</option>
                        <option value="allowed">Allowed</option>
                      </select>
                    </Field>
                  </div>
                );
              })()}
            </details>

            <div className="mt-4">
              <Field label="Form / outfit">
                {character.outfits.length > 0 ? (
                  <select
                    className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                    value={outfit}
                    onChange={(event) => setOutfit(event.target.value)}
                  >
                    {character.outfits.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={outfit}
                    onChange={(event) => setOutfit(event.target.value)}
                    placeholder="Default form / outfit"
                  />
                )}
              </Field>
              <div className="mt-3">
                <Field label="Exact outfit details">
                  <Textarea
                    value={character.outfitDetails?.[outfit] ?? ""}
                    onChange={(e) =>
                      useShiryuGenProductionStore
                        .getState()
                        .updateOutfitDetails(character.id, outfit, e.target.value)
                    }
                    placeholder="Navy jacket, silver trim, charcoal trousers, dark boots, left forearm cloth wrap"
                  />
                </Field>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <Field label="Consistency">
              <select
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                value={strategy}
                onChange={(event) =>
                  setStrategy(event.target.value as ShiryuGenConsistencyStrategy)
                }
              >
                {SHIRYUGEN_CONSISTENCY_STRATEGIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                    {entry.executable ? "" : " — prepared, not active"}
                  </option>
                ))}
              </select>
              <p className="text-xs leading-5 text-muted-foreground">
                {
                  SHIRYUGEN_CONSISTENCY_STRATEGIES.find((entry) => entry.value === strategy)
                    ?.description
                }
              </p>
            </Field>

            <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <SummaryTile label="Checkpoint" value={activeCheckpointLabel} />
              <SummaryTile
                label="Character LoRAs"
                value={
                  selectedCharacterLoras(character, strategy)
                    .map((lora) => `${lora.name} · ${lora.weight} · enabled`)
                    .join(", ") || "None"
                }
              />
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Primary continuity reference</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Canon is preferred; Approved is safe for generation.
                </p>
              </div>
              {hasCanonReference ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">
                  <CheckCircle2Icon className="size-3" /> Canon ready
                </span>
              ) : null}
            </div>

            {references.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 p-4">
                <div className="flex gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                    <ImagePlusIcon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">No canon reference yet</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Start with a clean full-body reference. Once you approve it as Canon, future
                      story shots can use it to preserve {character.name}&apos;s identity.
                    </p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => applyPreset(PROMPT_PRESETS[0]!)}
                    >
                      <WandSparklesIcon className="size-3.5" /> Fill first-reference scene
                    </Button>
                    <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                      This only fills the Scene / action box. ShiryuGen compiles the Character Kit,
                      exact outfit details, identity, and canon rules separately.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                {references.map((reference) => (
                  <button
                    key={reference.id}
                    type="button"
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      reference.id === referenceAssetId
                        ? "border-primary/60 bg-primary/10 ring-1 ring-primary/20"
                        : "border-border/70 bg-background/40 hover:bg-muted/30"
                    }`}
                    onClick={() => setReferenceAssetId(reference.id)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                        <ReferenceAssetPreview
                          asset={reference}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{reference.name}</div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span
                            className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${assetStatusClass(reference.status)}`}
                          >
                            {reference.status}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {reference.attachmentId ? "durable" : "preview"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            <div className="mb-3">
              <Label>Scene / action prompt</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This box is only for the shot, pose, camera, mood, and environment. Do not repeat
                hair, eyes, age, outfit construction, or canon rules already stored in the Character
                Kit; ShiryuGen compiles those separately.
              </p>
            </div>

            <div className="mb-3 flex flex-wrap gap-2">
              {PROMPT_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  size="sm"
                  variant="outline"
                  title={preset.description}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <Field label="Generation mode">
              <select
                className="mb-3 h-10 rounded-md border bg-background px-2 text-sm"
                value={sceneMode}
                onChange={(event) => setSceneMode(event.target.value as ShiryuGenSceneMode)}
              >
                <option value="first-canon-reference">First canon reference</option>
                <option value="story-scene">Story scene</option>
                <option value="classroom-scene">Classroom scene</option>
                <option value="emotional-closeup">Emotional close-up</option>
                <option value="action-scene">Action scene</option>
                <option value="magic-showcase">Magic showcase</option>
                <option value="transformation">Transformation</option>
              </select>
            </Field>
            <Textarea
              value={scenePrompt}
              onChange={(event) => setScenePrompt(event.target.value)}
              placeholder={`Describe what ${character.name} is doing, the camera framing, mood, and environment…`}
              className="min-h-36 resize-y text-sm leading-6"
            />

            {pipelinePreview ? (
              "error" in pipelinePreview ? (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-5 text-destructive">
                  {pipelinePreview.error}
                </div>
              ) : (
                <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3 text-xs">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-medium">Generation policy</div>
                      <span className="text-[10px] text-muted-foreground">
                        {pipelinePreview.pipeline.policy.version}
                      </span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      {[
                        ["Required", pipelinePreview.pipeline.policy.requiredConcepts],
                        ["Optional", pipelinePreview.pipeline.policy.optionalConcepts],
                        ["Forbidden", pipelinePreview.pipeline.policy.forbiddenConcepts],
                      ].map(([label, values]) => (
                        <div
                          key={label as string}
                          className="rounded-md border border-border/50 bg-background/45 p-2"
                        >
                          <div className="mb-1 font-medium">{label as string}</div>
                          <div className="max-h-28 overflow-auto leading-5 text-muted-foreground">
                            {(values as string[]).join(", ") || "None"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-md border border-border/50 bg-background/45 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium">Renderer prompt</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {rendererPromptReady
                            ? "Renderer prompt ready ✓"
                            : "Renderer prompt needs refresh"}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isPreparingPrompt}
                        onClick={() => void prepareRendererPrompt()}
                      >
                        {isPreparingPrompt ? "Preparing…" : "Prepare renderer prompt"}
                      </Button>
                    </div>
                    {preparedPrompt && preparedPipelineKey === pipelineKey ? (
                      <div className="mt-3 space-y-2">
                        {preparedPrompt.usedFallback ? (
                          <div className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-amber-200">
                            Local prompt formatter unavailable — using deterministic prompt.
                          </div>
                        ) : preparedPrompt.formatterModel ? (
                          <div className="text-[11px] text-muted-foreground">
                            Formatted locally with {preparedPrompt.formatterModel}
                          </div>
                        ) : null}
                        <div>
                          <div className="mb-1 font-medium">Positive prompt</div>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/60 p-2 font-mono text-[11px] leading-5">
                            {preparedPrompt.positivePrompt}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1 font-medium">Negative prompt</div>
                          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/60 p-2 font-mono text-[11px] leading-5">
                            {preparedPrompt.negativePrompt || "None"}
                          </pre>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-md border border-border/50 bg-background/45 p-2.5">
                    <div className="mb-2 font-medium">Validation</div>
                    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {(preparedValidation ?? pipelinePreview.pipeline.validation).checks.map(
                        (check) => (
                          <div
                            key={check.id}
                            className={check.valid ? "text-emerald-300" : "text-destructive"}
                            title={check.message}
                          >
                            {check.valid ? "✓" : "✕"} {check.label}
                          </div>
                        ),
                      )}
                    </div>
                    {preparedValidation && !preparedValidation.valid ? (
                      <div className="mt-2 text-destructive">
                        {preparedValidation.errors.join(" ")}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-md border border-border/50 bg-background/45 p-2.5">
                    <div className="mb-2 font-medium">Render settings</div>
                    <div className="grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-2">
                      <span>Model: {pipelinePreview.pipeline.policy.renderProfile.label}</span>
                      <span>
                        Checkpoint:{" "}
                        {pipelinePreview.pipeline.spec.checkpointPath ||
                          "character routing default"}
                      </span>
                      <span>
                        Resolution: {pipelinePreview.pipeline.policy.renderProfile.width}×
                        {pipelinePreview.pipeline.policy.renderProfile.height}
                      </span>
                      <span>Steps: {pipelinePreview.pipeline.policy.renderProfile.steps}</span>
                      <span>CFG: {pipelinePreview.pipeline.policy.renderProfile.guidance}</span>
                      <span>Sampler: {pipelinePreview.pipeline.policy.renderProfile.sampler}</span>
                      <span>
                        Scheduler: {pipelinePreview.pipeline.policy.renderProfile.scheduler}
                      </span>
                      <span>
                        Character LoRAs:{" "}
                        {selectedCharacterLoras(character, strategy)
                          .map((lora) => `${lora.name} · ${lora.weight}`)
                          .join(", ") || "None"}
                      </span>
                      <span>Reference: {pipelinePreview.pipeline.spec.referenceState}</span>
                    </div>
                  </div>
                </div>
              )
            ) : null}

            {error ? (
              <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                {firstCanonReference
                  ? "First canon reference: no prior visual reference will be forced."
                  : selectedReference
                    ? `Using ${selectedReference.status} reference: ${selectedReference.name}`
                    : "No Canon/Approved visual reference selected."}
                {!rendererPromptReady
                  ? " Prepare and validate the renderer prompt to enable Generate."
                  : ""}
              </div>
              <Button className="min-w-44" disabled={!canGenerate} onClick={() => void generate()}>
                <SparklesIcon className="size-4" />
                {isGenerating ? "Starting…" : `Generate ${character.name}`}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {showDefaults ? (
        <div className="mx-5 mb-5 rounded-xl border border-border/70 bg-background/50 p-4 sm:mx-6 sm:mb-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">Character-specific generation overrides</h3>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                Optional. Leave these on <strong>Automatic character routing default</strong> unless{" "}
                {character.name}
                should always use a different checkpoint or identity LoRA than the rest of
                ShiryuGen.
              </p>
            </div>
            <span className="rounded-full border border-border/70 bg-muted/20 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Advanced
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Checkpoint override">
              <select
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                value={checkpointSelectValue}
                onChange={(event) => chooseCheckpoint(event.target.value)}
              >
                <option value={INHERIT_CHECKPOINT}>
                  Automatic character routing default · {globalCheckpoint}
                </option>
                {installedCheckpoints.map((entry) => (
                  <option
                    key={`${entry.modelId}:${entry.versionId}`}
                    value={`installed:${entry.modelId}:${entry.versionId}`}
                  >
                    {entry.modelName} · {entry.versionName}
                  </option>
                ))}
                <option value={MANUAL_CHECKPOINT}>Manual checkpoint path…</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Installed checkpoints from Models appear here automatically.
              </p>
            </Field>

            <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
              <div className="text-xs font-medium">Resolved checkpoint</div>
              <div className="mt-1 truncate text-sm">{activeCheckpointLabel}</div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {checkpointPath.trim() || "Using global ShiryuGen image-generation settings"}
              </div>
            </div>
          </div>

          {checkpointSelectValue === MANUAL_CHECKPOINT ? (
            <details className="mt-4 rounded-lg border border-border/60 bg-muted/10 p-3" open>
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
                <ChevronDownIcon className="size-4" /> Manual checkpoint path
              </summary>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <Field label="Display name">
                  <Input
                    value={checkpointName}
                    onChange={(event) => setCheckpointName(event.target.value)}
                    placeholder="Anime XL"
                  />
                </Field>
                <Field label="Absolute .safetensors path">
                  <Input
                    value={checkpointPath}
                    onChange={(event) => {
                      const path = event.target.value;
                      setCheckpointPath(path);
                      if (!checkpointName.trim() && path.trim()) {
                        setCheckpointName(fileNameFromPath(path));
                      }
                    }}
                    placeholder="/models/checkpoints/model.safetensors"
                  />
                </Field>
              </div>
            </details>
          ) : null}

          <div className="mt-5 border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label>Character LoRAs</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Usually unnecessary until you have or train a LoRA specifically for this
                  character.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {installedLoras.length > 0 ? (
                  <select
                    className="h-8 max-w-64 rounded-md border border-border bg-background px-2 text-xs"
                    value=""
                    onChange={(event) => {
                      if (!event.target.value) return;
                      addInstalledLora(event.target.value);
                      event.currentTarget.value = "";
                    }}
                  >
                    <option value="">Add installed LoRA…</option>
                    {installedLoras.map((entry) => (
                      <option
                        key={`${entry.modelId}:${entry.versionId}`}
                        value={`${entry.modelId}:${entry.versionId}`}
                      >
                        {entry.modelName}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setLoras((current) => [...current, defaultLora()])}
                >
                  <PlusIcon className="size-3.5" /> Add Character LoRA
                </Button>
              </div>
            </div>

            {installedModelsError ? (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Installed model library could not be loaded: {installedModelsError}
              </div>
            ) : null}

            {loras.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
                No Character LoRA configured. Auto can use a saved Canon/Approved reference; global
                LoRAs are excluded. Save overrides to apply changes. Reference controls remain
                available.
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {loras.map((lora, index) => (
                  <div
                    key={lora.id}
                    className="grid gap-2 rounded-lg border border-border/70 bg-background/35 p-3 lg:grid-cols-[0.8fr_1.4fr_7rem_auto_auto]"
                  >
                    <Input
                      aria-label={`LoRA ${index + 1} name`}
                      value={lora.name}
                      onChange={(event) =>
                        setLoras((current) =>
                          current.map((entry) =>
                            entry.id === lora.id ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="Character identity"
                    />
                    <Input
                      aria-label={`LoRA ${index + 1} path`}
                      value={lora.path}
                      onChange={(event) =>
                        setLoras((current) =>
                          current.map((entry) =>
                            entry.id === lora.id ? { ...entry, path: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="/models/loras/character.safetensors"
                    />
                    <Input
                      aria-label={`LoRA ${index + 1} weight`}
                      type="number"
                      min={-2}
                      max={2}
                      step={0.05}
                      value={lora.weight}
                      onChange={(event) => {
                        const weight = Number(event.target.value);
                        setLoras((current) =>
                          current.map((entry) =>
                            entry.id === lora.id && Number.isFinite(weight)
                              ? { ...entry, weight }
                              : entry,
                          ),
                        );
                      }}
                    />
                    <label className="flex items-center gap-2 whitespace-nowrap text-xs">
                      <input
                        type="checkbox"
                        checked={lora.enabled}
                        onChange={(event) =>
                          setLoras((current) =>
                            current.map((entry) =>
                              entry.id === lora.id
                                ? { ...entry, enabled: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                      />
                      Enabled
                    </label>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${lora.name}`}
                      onClick={() =>
                        setLoras((current) => current.filter((entry) => entry.id !== lora.id))
                      }
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-xs text-muted-foreground">
              Save to apply checkpoint and LoRA changes. Character generation uses only saved,
              enabled Character LoRAs.
            </p>
            <Button onClick={saveGenerationDefaults}>Save character overrides</Button>
          </div>
        </div>
      ) : null}

      <div className="border-t border-border/60 bg-muted/[0.04] p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Generated image review</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              After generating in chat, add the image back to this Character Kit. Review it here and
              promote only the images you want ShiryuGen to reuse.
            </p>
          </div>
        </div>

        {recentGeneratedAssets.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border/70 p-5 text-sm text-muted-foreground">
            No generated images have been added back to {character.name} yet. Generate an image,
            then use <strong>Add to Character Kit</strong> from the image toolbar.
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {recentGeneratedAssets.map((asset) => (
              <article
                key={asset.id}
                className="overflow-hidden rounded-xl border border-border/70 bg-background/45"
              >
                <div className="aspect-[4/3] bg-muted/30">
                  <ReferenceAssetPreview asset={asset} className="h-full w-full object-cover" />
                </div>
                <div className="space-y-3 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide ${assetStatusClass(asset.status)}`}
                    >
                      {asset.status}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(asset.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                    {asset.generationPrompt || asset.name}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant={asset.status === "canon" ? "default" : "outline"}
                      onClick={() => promoteAsset(asset, "canon")}
                    >
                      Canon
                    </Button>
                    <Button
                      size="sm"
                      variant={asset.status === "approved" ? "default" : "outline"}
                      onClick={() => promoteAsset(asset, "approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      className="col-span-2"
                      size="sm"
                      variant="ghost"
                      onClick={() => promoteAsset(asset, "rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Step(props: { number: string; label: string; value: string; active: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        props.active ? "border-primary/35 bg-primary/[0.06]" : "border-border/60 bg-background/25"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
            props.active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          }`}
        >
          {props.number}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.label}
        </span>
      </div>
      <div className="mt-1 truncate text-xs font-medium">{props.value}</div>
    </div>
  );
}

function SummaryTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      <div className="mt-1 truncate text-xs font-medium">{props.value}</div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}
