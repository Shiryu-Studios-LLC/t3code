import { useAtomValue } from "@effect/atom-react";
import {
  MAX_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY,
  MIN_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY,
  ProviderDriverKind,
  type LocalImageCheckpointSelection,
  type LocalImageGenerationEngine,
  type LocalImageLoraConfig,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import {
  CheckCircle2Icon,
  HardDriveIcon,
  ImageIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";

import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { primaryServerProvidersAtom } from "~/state/server";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const CHECKPOINT_OPTIONS: ReadonlyArray<{
  readonly value: LocalImageCheckpointSelection;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "auto",
    label: "Automatic (recommended)",
    description: "ShiryuGen chooses a checkpoint from the prompt.",
  },
  { value: "nova-unreal", label: "Nova Unreal XL", description: "Realistic and general-purpose." },
  {
    value: "nova-anime",
    label: "Nova Anime XL",
    description: "Preferred for anime characters and series art.",
  },
  {
    value: "perfect-anima",
    label: "Perfect Anima AIO",
    description: "Alternate anime and illustration checkpoint.",
  },
  { value: "nova-furry", label: "Nova Furry XL", description: "Anthro, furry, and creature art." },
  { value: "nova-pkm", label: "Nova PKM XL", description: "Pokémon-style subjects." },
  {
    value: "nova-mature",
    label: "Nova Mature XL",
    description: "Mature-oriented local checkpoint.",
  },
  {
    value: "custom",
    label: "Custom checkpoint",
    description: "Use a .safetensors file from this host.",
  },
];

const GENERATION_ENGINES: ReadonlyArray<{
  readonly value: LocalImageGenerationEngine;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "auto",
    label: "Automatic",
    description:
      "Use headless ComfyUI when available, with the built-in Diffusers path as fallback.",
  },
  {
    value: "comfyui",
    label: "Headless ComfyUI",
    description: "Use ComfyUI's API as ShiryuGen's workflow runtime without opening its UI.",
  },
  {
    value: "diffusers",
    label: "Built-in Diffusers",
    description: "Use ShiryuGen's current direct local SDXL runtime.",
  },
];

const QUALITY_PRESETS = [
  { label: "Fast", width: 512, height: 512, steps: 12, guidance: 5 },
  { label: "Balanced", width: 768, height: 768, steps: 24, guidance: 5.5 },
  { label: "High", width: 1024, height: 1024, steps: 32, guidance: 6 },
] as const;

function checkpointLabel(value: LocalImageCheckpointSelection): string {
  return CHECKPOINT_OPTIONS.find((option) => option.value === value)?.label ?? "Automatic";
}

function clampCommittedNumber(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

export function ImageGenerationSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const imageSettings = settings.imageGeneration;
  const imageVisionSpecialist = settings.specialistModels.imageVision;
  const providerEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const imageVisionInstanceEntries = providerEntries.filter(
    (entry) => entry.driverKind === ProviderDriverKind.make("ollama"),
  );
  const imageVisionModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    imageVisionSpecialist.instanceId,
    imageVisionSpecialist.model,
  );

  const updateImageSettings = (patch: Partial<typeof imageSettings>) =>
    updateSettings({ imageGeneration: patch });

  const replaceLora = (id: string, update: (lora: LocalImageLoraConfig) => LocalImageLoraConfig) =>
    updateImageSettings({
      loras: imageSettings.loras.map((lora) => (lora.id === id ? update(lora) : lora)),
    });

  const addLora = () => {
    const suffix = imageSettings.loras.length + 1;
    updateImageSettings({
      loras: [
        ...imageSettings.loras,
        {
          id: `local-lora-${Date.now().toString(36)}-${suffix}`,
          name: `LoRA ${suffix}`,
          path: "",
          weight: 0.8,
          enabled: true,
        },
      ],
    });
  };

  const imageDefaultsDirty = !Equal.equals(imageSettings, DEFAULT_UNIFIED_SETTINGS.imageGeneration);

  return (
    <>
      <SettingsRow
        id="local-image-generation"
        title="Local image generation"
        description="Built into ShiryuGen. Runs locally through Diffusers/SDXL and is available to chat, image editing, and supported agent tool sessions without a cloud image API key."
        resetAction={
          settings.preferLocalImageGeneration !==
          DEFAULT_UNIFIED_SETTINGS.preferLocalImageGeneration ? (
            <SettingResetButton
              label="local image generation preference"
              onClick={() =>
                updateSettings({
                  preferLocalImageGeneration: DEFAULT_UNIFIED_SETTINGS.preferLocalImageGeneration,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium text-muted-foreground">
              <CheckCircle2Icon className="size-3.5" /> Installed · Local
            </span>
            <Switch
              checked={settings.preferLocalImageGeneration}
              onCheckedChange={(checked) =>
                updateSettings({ preferLocalImageGeneration: Boolean(checked) })
              }
              aria-label="Prefer local image generation"
            />
          </div>
        }
      >
        <div className="mt-2 flex items-start gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 text-sm text-muted-foreground">
          <ImageIcon className="mt-0.5 size-4 shrink-0" />
          <p>
            The generator is a built-in ShiryuGen integration, so it does not appear in the external
            MCP server list. It still exposes the <code>t3_generate_image</code> tool to supported
            agents.
          </p>
        </div>
      </SettingsRow>

      <SettingsRow
        id="image-generation-engine"
        title="Generation engine"
        description="Choose the local runtime ShiryuGen uses. Headless ComfyUI is the workflow engine for advanced image/video pipelines; Diffusers remains available as the lightweight fallback."
        control={
          <Select
            value={imageSettings.engine}
            onValueChange={(value) => {
              if (!value) return;
              updateImageSettings({ engine: value as LocalImageGenerationEngine });
            }}
          >
            <SelectTrigger className="w-56" aria-label="Image generation engine">
              <SelectValue>
                {GENERATION_ENGINES.find((entry) => entry.value === imageSettings.engine)?.label ??
                  "Automatic"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-80">
              {GENERATION_ENGINES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  <span className="flex flex-col">
                    <span>{entry.label}</span>
                    <span className="text-[11px] text-muted-foreground">{entry.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {imageSettings.engine !== "diffusers" ? (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <div className="md:col-span-2 flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-foreground">
                  Auto-start ComfyUI with ShiryuGen
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Starts the local headless ComfyUI API automatically when ShiryuGen launches.
                </p>
              </div>
              <Switch
                checked={imageSettings.autoStartComfyUi}
                onCheckedChange={(checked) =>
                  updateImageSettings({ autoStartComfyUi: Boolean(checked) })
                }
                aria-label="Auto-start ComfyUI with ShiryuGen"
              />
            </div>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              <span>Headless ComfyUI endpoint</span>
              <Input
                aria-label="Headless ComfyUI endpoint"
                value={imageSettings.comfyUiEndpoint}
                placeholder="http://127.0.0.1:8188"
                onChange={(event) =>
                  updateImageSettings({ comfyUiEndpoint: event.currentTarget.value })
                }
              />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              <span>ComfyUI root directory</span>
              <Input
                aria-label="ComfyUI root directory"
                value={imageSettings.comfyUiRootDirectory}
                placeholder="/path/to/ComfyUI"
                onChange={(event) =>
                  updateImageSettings({ comfyUiRootDirectory: event.currentTarget.value })
                }
              />
            </label>
            <p className="md:col-span-2 text-xs text-muted-foreground">
              ShiryuGen installs CivitAI files beneath this directory&apos;s <code>models</code>{" "}
              folder and records them in <code>.shiryugen/installed-models.json</code>.
            </p>
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        id="model-download-concurrency"
        title="Model download concurrency"
        description="Maximum number of CivitAI model downloads ShiryuGen runs at the same time. Extra installs stay queued and start automatically when a slot opens."
        control={
          <NumberField
            value={imageSettings.modelDownloadConcurrency}
            min={MIN_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY}
            max={MAX_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY}
            step={1}
            onValueCommitted={(value) => {
              const next = clampCommittedNumber(
                value,
                MIN_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY,
                MAX_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY,
              );
              if (next !== null) {
                updateImageSettings({ modelDownloadConcurrency: Math.round(next) });
              }
            }}
          >
            <NumberFieldGroup className="w-24">
              <NumberFieldInput aria-label="Model download concurrency" />
            </NumberFieldGroup>
          </NumberField>
        }
      />

      <SettingsRow
        id="image-checkpoint"
        title="Checkpoint"
        description="Choose the SDXL checkpoint used for new images. Automatic keeps ShiryuGen's prompt-based routing; Custom lets you point at another local .safetensors checkpoint."
        control={
          <Select
            value={imageSettings.checkpoint}
            onValueChange={(value) => {
              if (!value) return;
              updateImageSettings({ checkpoint: value as LocalImageCheckpointSelection });
            }}
          >
            <SelectTrigger className="w-56" aria-label="Image generation checkpoint">
              <SelectValue>{checkpointLabel(imageSettings.checkpoint)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-72">
              {CHECKPOINT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-[11px] text-muted-foreground">{option.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {imageSettings.checkpoint === "custom" ? (
          <div className="mt-2 flex items-center gap-2">
            <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Custom image checkpoint path"
              value={imageSettings.customCheckpointPath}
              placeholder="/path/to/model.safetensors"
              onChange={(event) =>
                updateImageSettings({ customCheckpointPath: event.currentTarget.value })
              }
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        id="image-quality"
        title="Quality & resolution"
        description="Defaults used when a request does not override them. Higher resolution and more steps improve detail but take longer and use more memory."
        resetAction={
          imageDefaultsDirty ? (
            <SettingResetButton
              label="image generation quality defaults"
              onClick={() =>
                updateSettings({ imageGeneration: DEFAULT_UNIFIED_SETTINGS.imageGeneration })
              }
            />
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 pb-1 pt-2">
          <span className="me-1 text-xs text-muted-foreground">Preset</span>
          {QUALITY_PRESETS.map((preset) => {
            const active =
              imageSettings.width === preset.width &&
              imageSettings.height === preset.height &&
              imageSettings.steps === preset.steps &&
              imageSettings.guidance === preset.guidance;
            return (
              <Button
                key={preset.label}
                size="xs"
                variant={active ? "secondary" : "outline"}
                onClick={() =>
                  updateImageSettings({
                    width: preset.width,
                    height: preset.height,
                    steps: preset.steps,
                    guidance: preset.guidance,
                  })
                }
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
        <div className="grid gap-3 pb-2 pt-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>Width</span>
            <NumberField
              value={imageSettings.width}
              min={256}
              max={1024}
              step={64}
              onValueCommitted={(value) => {
                const next = clampCommittedNumber(value, 256, 1024);
                if (next !== null) updateImageSettings({ width: Math.round(next / 64) * 64 });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Image width" />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>Height</span>
            <NumberField
              value={imageSettings.height}
              min={256}
              max={1024}
              step={64}
              onValueCommitted={(value) => {
                const next = clampCommittedNumber(value, 256, 1024);
                if (next !== null) updateImageSettings({ height: Math.round(next / 64) * 64 });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Image height" />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>Steps</span>
            <NumberField
              value={imageSettings.steps}
              min={4}
              max={40}
              step={1}
              onValueCommitted={(value) => {
                const next = clampCommittedNumber(value, 4, 40);
                if (next !== null) updateImageSettings({ steps: Math.round(next) });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Image inference steps" />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>CFG guidance</span>
            <NumberField
              value={imageSettings.guidance}
              min={0}
              max={20}
              step={0.5}
              onValueCommitted={(value) => {
                const next = clampCommittedNumber(value, 0, 20);
                if (next !== null) updateImageSettings({ guidance: next });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Image guidance scale" />
              </NumberFieldGroup>
            </NumberField>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>Image edit strength</span>
            <NumberField
              value={imageSettings.editStrength}
              min={0.05}
              max={1}
              step={0.05}
              onValueCommitted={(value) => {
                const next = clampCommittedNumber(value, 0.05, 1);
                if (next !== null) updateImageSettings({ editStrength: next });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Image edit strength" />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span>Negative prompt</span>
            <Textarea
              value={imageSettings.negativePrompt}
              aria-label="Default image negative prompt"
              className="min-h-20"
              onChange={(event) =>
                updateImageSettings({ negativePrompt: event.currentTarget.value })
              }
            />
          </label>
        </div>
      </SettingsRow>

      <SettingsRow
        id="image-loras"
        title="LoRAs"
        description="Stack optional local LoRA adapters on top of the selected checkpoint. Weights from about 0.5–1.0 are a common starting point; ShiryuGen accepts -2 to 2."
        control={
          <Button size="sm" variant="outline" onClick={addLora}>
            <PlusIcon /> Add LoRA
          </Button>
        }
      >
        <div className="space-y-2 pb-2 pt-2">
          {imageSettings.loras.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 px-4 py-5 text-center text-sm text-muted-foreground">
              No LoRAs configured. Add one to use a local .safetensors adapter during generation.
            </div>
          ) : null}
          {imageSettings.loras.map((lora) => (
            <div key={lora.id} className="rounded-lg border border-border/60 bg-muted/15 p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(8rem,0.8fr)_minmax(14rem,2fr)_7rem_auto_auto] sm:items-center">
                <Input
                  aria-label={`LoRA name ${lora.name}`}
                  value={lora.name}
                  placeholder="LoRA name"
                  onChange={(event) =>
                    replaceLora(lora.id, (current) => ({
                      ...current,
                      name: event.currentTarget.value || current.name,
                    }))
                  }
                />
                <Input
                  aria-label={`LoRA path ${lora.name}`}
                  value={lora.path}
                  placeholder="/path/to/lora.safetensors"
                  onChange={(event) =>
                    replaceLora(lora.id, (current) => ({
                      ...current,
                      path: event.currentTarget.value,
                    }))
                  }
                />
                <NumberField
                  value={lora.weight}
                  min={-2}
                  max={2}
                  step={0.05}
                  onValueCommitted={(value) => {
                    const next = clampCommittedNumber(value, -2, 2);
                    if (next !== null)
                      replaceLora(lora.id, (current) => ({ ...current, weight: next }));
                  }}
                >
                  <NumberFieldGroup>
                    <NumberFieldInput aria-label={`LoRA weight ${lora.name}`} />
                  </NumberFieldGroup>
                </NumberField>
                <Switch
                  checked={lora.enabled}
                  onCheckedChange={(enabled) =>
                    replaceLora(lora.id, (current) => ({ ...current, enabled: Boolean(enabled) }))
                  }
                  aria-label={`Enable LoRA ${lora.name}`}
                />
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`Remove LoRA ${lora.name}`}
                  onClick={() =>
                    updateImageSettings({
                      loras: imageSettings.loras.filter((candidate) => candidate.id !== lora.id),
                    })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow
        id="image-vision-specialist"
        title="Image / vision specialist"
        description="The local vision model that refines image prompts and inspects reference images before SDXL runs. It does not replace the model selected for ordinary chat or coding."
        resetAction={
          !Equal.equals(
            imageVisionSpecialist,
            DEFAULT_UNIFIED_SETTINGS.specialistModels.imageVision,
          ) ? (
            <SettingResetButton
              label="image / vision specialist"
              onClick={() =>
                updateSettings({
                  specialistModels: {
                    imageVision: DEFAULT_UNIFIED_SETTINGS.specialistModels.imageVision,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <ProviderModelPicker
            activeInstanceId={imageVisionSpecialist.instanceId}
            model={imageVisionSpecialist.model}
            lockedProvider={ProviderDriverKind.make("ollama")}
            instanceEntries={imageVisionInstanceEntries}
            modelOptionsByInstance={imageVisionModelOptionsByInstance}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            triggerAriaLabel="Image / vision specialist model"
            onInstanceModelChange={(instanceId, model) =>
              updateSettings({
                specialistModels: {
                  imageVision: createModelSelection(instanceId, model),
                },
              })
            }
          />
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/15 p-3 text-xs text-muted-foreground">
        <SlidersHorizontalIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          Settings are server-authoritative, so desktop and web clients connected to this ShiryuGen
          host use the same checkpoint, LoRAs, and quality defaults.
        </p>
      </div>
    </>
  );
}
