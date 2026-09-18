import { resolveImageGenerationProfile } from "@t3tools/shared/imageGenerationProfiles";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  compileImg2ImgWorkflow,
  compileTxt2ImgWorkflow,
} from "../../../shiryuGen/ComfyWorkflowCompiler.ts";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { ImageGenerationError, ImageGenerationToolkit, type LocalImageModel } from "./tools.ts";

const checkpointHashCache = new Map<string, string>();

async function getCheckpointShortHash(filePath: string): Promise<string | undefined> {
  if (checkpointHashCache.has(filePath)) {
    return checkpointHashCache.get(filePath);
  }
  try {
    const fileHandle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
      const stat = await fileHandle.stat();
      const hash = createHash("sha256");
      hash.update(buffer.subarray(0, bytesRead));
      hash.update(`:size:${stat.size}`);
      const shortHash = hash.digest("hex").slice(0, 10);
      checkpointHashCache.set(filePath, shortHash);
      return shortHash;
    } finally {
      await fileHandle.close();
    }
  } catch {
    return undefined;
  }
}

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function localPathSeparator(value: string): "/" | "\\" {
  return value.includes("\\") && !value.includes("/") ? "\\" : "/";
}

function joinLocalPath(root: string, ...parts: string[]): string {
  const separator = localPathSeparator(root);
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const normalizedParts = parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [normalizedRoot, ...normalizedParts].filter(Boolean).join(separator);
}

function localPathDirname(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  const directory = normalized.slice(0, index);
  return localPathSeparator(value) === "\\" ? directory.replaceAll("/", "\\") : directory;
}

function localPathExtension(value: string): string {
  const base = value.replaceAll("\\", "/").split("/").at(-1) ?? value;
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.slice(dotIndex) : "";
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

interface DirectComfyImage {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

type DirectComfyHistory = Record<
  string,
  {
    readonly outputs?: Readonly<
      Record<string, { readonly images?: ReadonlyArray<DirectComfyImage> }>
    >;
    readonly status?: { readonly status_str?: string };
  }
>;

function comfyJson<T>(url: string, body?: unknown): Effect.Effect<T, ImageGenerationError> {
  return HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        body === undefined
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      ),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
    Effect.map((value) => value as T),
    Effect.mapError(
      (cause) =>
        new ImageGenerationError({
          message: `Headless ComfyUI request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );
}

const executeComfyWorkflowDirect = Effect.fn("executeComfyWorkflowDirect")(function* (input: {
  readonly endpoint: string;
  readonly workflow: Readonly<
    Record<
      string,
      { readonly class_type: string; readonly inputs: Readonly<Record<string, unknown>> }
    >
  >;
  readonly outputPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const endpoint = input.endpoint.replace(/\/+$/, "");
  const objectInfo = yield* comfyJson<Record<string, unknown>>(`${endpoint}/object_info`);
  const requiredNodes = [...new Set(Object.values(input.workflow).map((node) => node.class_type))];
  const missingNodes = requiredNodes.filter((nodeName) => !(nodeName in objectInfo));
  if (missingNodes.length > 0) {
    return yield* new ImageGenerationError({
      message: `Headless ComfyUI is missing required nodes: ${missingNodes.join(", ")}.`,
    });
  }

  const queued = yield* comfyJson<{ readonly prompt_id?: string }>(`${endpoint}/prompt`, {
    prompt: input.workflow,
  });
  const promptId = queued.prompt_id?.trim();
  if (!promptId) {
    return yield* new ImageGenerationError({
      message: "Headless ComfyUI accepted the request but did not return a prompt id.",
    });
  }

  let completedImage: DirectComfyImage | null = null;
  for (let attempt = 0; attempt < 720 && completedImage === null; attempt += 1) {
    const history = yield* comfyJson<DirectComfyHistory>(
      `${endpoint}/history/${encodeURIComponent(promptId)}`,
    );
    const entry = history[promptId];
    if (entry?.status?.status_str === "error") {
      return yield* new ImageGenerationError({
        message: `Headless ComfyUI workflow ${promptId} failed. Check the ComfyUI execution log for the selected checkpoint.`,
      });
    }
    if (entry?.outputs) {
      for (const output of Object.values(entry.outputs)) {
        const image = output.images?.[0];
        if (image) {
          completedImage = image;
          break;
        }
      }
    }
    if (completedImage === null) {
      yield* Effect.sleep("250 millis");
    }
  }
  if (completedImage === null) {
    return yield* new ImageGenerationError({
      message: `Headless ComfyUI workflow ${promptId} did not finish within 3 minutes.`,
    });
  }

  const viewUrl = new URL(`${endpoint}/view`);
  viewUrl.searchParams.set("filename", completedImage.filename);
  viewUrl.searchParams.set("subfolder", completedImage.subfolder);
  viewUrl.searchParams.set("type", completedImage.type);
  const bytes = yield* HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.execute(HttpClientRequest.get(viewUrl.toString()))),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) =>
        new ImageGenerationError({
          message: `Could not download the completed ComfyUI image: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );
  yield* fs.writeFile(input.outputPath, bytes).pipe(
    Effect.mapError(
      (cause) =>
        new ImageGenerationError({
          message: `Could not save the completed ComfyUI image: ${cause.message}`,
        }),
    ),
  );
  return { promptId, outputPath: input.outputPath };
});

const CHECKPOINTS: Readonly<Record<Exclude<LocalImageModel, "custom">, string>> = {
  "nova-unreal":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/novaUnrealXL_v100.safetensors",
  "nova-anime":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/novaAnimeXL_ilV190.safetensors",
  "perfect-anima":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/perfectrsbmixAnimaAIO_gamma.safetensors",
  "nova-furry":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/novaFurryXL_ilV170.safetensors",
  "nova-pkm":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/novaPKMXL_v10.safetensors",
  "nova-mature":
    "/mnt/Development/ShiryuStudiosLLC/ShiryuComfy/ComfyUI/models/checkpoints/novaMatureXL_v40.safetensors",
};

const PYTHON_GENERATOR = String.raw`
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from diffusers import (
    DPMSolverMultistepScheduler,
    EulerAncestralDiscreteScheduler,
    StableDiffusionXLPipeline,
    StableDiffusionXLImg2ImgPipeline,
)

payload = json.load(sys.stdin)
checkpoint = payload["checkpoint"]
output_path = payload["outputPath"]
prompt = payload["prompt"]
negative_prompt = payload["negativePrompt"]
width = int(payload["width"])
height = int(payload["height"])
steps = int(payload["steps"])
guidance = float(payload["guidance"])
seed = int(payload["seed"])
reference_image_path = payload.get("referenceImagePath")
edit_strength = float(payload.get("editStrength", 0.5))
loras = payload.get("loras", [])

started = time.monotonic()
Pipeline = StableDiffusionXLImg2ImgPipeline if reference_image_path else StableDiffusionXLPipeline
pipe = Pipeline.from_single_file(
    checkpoint,
    torch_dtype=torch.float16,
    use_safetensors=True,
)
if payload.get("sampler") == "euler_ancestral":
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
else:
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
if loras:
    adapter_names = []
    adapter_weights = []
    for index, lora in enumerate(loras):
        adapter_name = f"t3_lora_{index}"
        lora_path = Path(lora["path"])
        pipe.load_lora_weights(
            str(lora_path.parent),
            weight_name=lora_path.name,
            adapter_name=adapter_name,
        )
        adapter_names.append(adapter_name)
        adapter_weights.append(float(lora["weight"]))
    pipe.set_adapters(adapter_names, adapter_weights=adapter_weights)
# Sequential offload is intentionally used instead of normal model offload.
# T3 can have Kokoro and other desktop GPU clients resident at the same time;
# this keeps local image generation usable on an 8 GB card instead of taking
# ownership of nearly all VRAM.
pipe.enable_sequential_cpu_offload()
pipe.enable_attention_slicing()
pipe.vae.enable_tiling()

generator = torch.Generator(device="cpu").manual_seed(seed)
if reference_image_path:
    reference = Image.open(reference_image_path).convert("RGB").resize((width, height))
    image = pipe(
        prompt,
        image=reference,
        strength=edit_strength,
        negative_prompt=negative_prompt,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    ).images[0]
else:
    image = pipe(
        prompt,
        negative_prompt=negative_prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    ).images[0]
Path(output_path).parent.mkdir(parents=True, exist_ok=True)
image.save(output_path, format="PNG")
print(json.dumps({"elapsedMs": round((time.monotonic() - started) * 1000)}))
`;

function integerSetting(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new ImageGenerationError({
      message: `${label} must be an integer between ${min} and ${max}.`,
    });
  }
  return resolved;
}

function dimensionSetting(value: number | undefined, fallback: number, label: string): number {
  const resolved = integerSetting(value, fallback, 256, 1024, label);
  if (resolved % 64 !== 0) {
    throw new ImageGenerationError({ message: `${label} must be a multiple of 64.` });
  }
  return resolved;
}

export interface LocalImageGenerationRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly model?: LocalImageModel;
  readonly width?: number;
  readonly height?: number;
  readonly steps?: number;
  readonly guidance?: number;
  readonly sampler?: string;
  readonly scheduler?: string;
  readonly seed?: number;
  readonly referenceImagePath?: string;
  readonly checkpointPath?: string;
  readonly editStrength?: number;
  readonly loras?: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly weight: number;
  }>;
}

/** Provider-independent local SDXL entry point shared by MCP and the native image RPC. */
export const generateLocalImage = Effect.fn("generateLocalImage")(function* (
  input: LocalImageGenerationRequest,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new ImageGenerationError({
          message: `Could not read image generation settings: ${cause.message}`,
        }),
    ),
  );
  const imageSettings = settings.imageGeneration;

  const requestedPrompt = input.prompt.trim();
  if (!requestedPrompt) {
    return yield* new ImageGenerationError({ message: "Image prompt cannot be empty." });
  }
  const configuredCheckpoint = imageSettings.checkpoint;
  const model =
    input.model ?? (configuredCheckpoint === "auto" ? "nova-unreal" : configuredCheckpoint);
  const checkpoint =
    input.checkpointPath?.trim() ||
    (model === "custom" ? imageSettings.customCheckpointPath.trim() : CHECKPOINTS[model]);
  if (!checkpoint) {
    return yield* new ImageGenerationError({
      message: "Choose a custom checkpoint file in Settings → Integrations → Image Generation.",
    });
  }
  if (!(yield* fs.exists(checkpoint).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new ImageGenerationError({
      message: `Local image checkpoint for '${model}' is missing: ${checkpoint}`,
    });
  }
  if (
    input.referenceImagePath &&
    !(yield* fs.exists(input.referenceImagePath).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return yield* new ImageGenerationError({
      message: `Reference image is unavailable: ${input.referenceImagePath}`,
    });
  }

  const profile = resolveImageGenerationProfile(checkpoint);
  const sampler = input.sampler?.trim() || profile.sampler;
  const scheduler = input.scheduler?.trim() || profile.scheduler;
  const prompt = requestedPrompt.startsWith(profile.positivePrefix)
    ? requestedPrompt
    : [profile.positivePrefix, requestedPrompt].filter(Boolean).join(", ");
  const requestedNegative = input.negativePrompt ?? imageSettings.negativePrompt;
  const negativePrompt = requestedNegative.startsWith(profile.negativeBaseline)
    ? requestedNegative
    : [profile.negativeBaseline, requestedNegative].filter(Boolean).join(", ");
  const width = dimensionSetting(input.width, imageSettings.width, "width");
  const height = dimensionSetting(input.height, imageSettings.height, "height");
  const steps = integerSetting(input.steps, imageSettings.steps, 4, 40, "steps");
  const guidance = input.guidance ?? imageSettings.guidance;
  if (!Number.isFinite(guidance) || guidance < 0 || guidance > 20) {
    return yield* new ImageGenerationError({
      message: "guidance must be a finite number between 0 and 20.",
    });
  }

  const editStrength = input.editStrength ?? imageSettings.editStrength;
  if (!Number.isFinite(editStrength) || editStrength < 0.05 || editStrength > 1) {
    return yield* new ImageGenerationError({
      message: "edit strength must be a finite number between 0.05 and 1.",
    });
  }
  const activeLoras = (input.loras ?? imageSettings.loras.filter((lora) => lora.enabled)).filter(
    (lora) => lora.path.trim(),
  );
  for (const lora of activeLoras) {
    if (!Number.isFinite(lora.weight) || lora.weight < -2 || lora.weight > 2) {
      return yield* new ImageGenerationError({
        message: `LoRA '${lora.name}' weight must be between -2 and 2.`,
      });
    }
    if (!(yield* fs.exists(lora.path).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new ImageGenerationError({
        message: `LoRA '${lora.name}' is missing: ${lora.path}`,
      });
    }
  }

  const uuid = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      () => new ImageGenerationError({ message: "Could not allocate an image identifier." }),
    ),
  );
  const seed =
    input.seed === undefined
      ? Number.parseInt(uuid.replaceAll("-", "").slice(0, 8), 16)
      : integerSetting(input.seed, 0, 0, 2_147_483_647, "seed");
  const outputDirectory = `${process.env.HOME?.trim() || "/tmp"}/generated_images`;
  const outputPath = `${outputDirectory}/${uuid}.png`;
  yield* fs
    .makeDirectory(outputDirectory, { recursive: true })
    .pipe(
      Effect.mapError(
        () =>
          new ImageGenerationError({ message: "Could not create the generated_images folder." }),
      ),
    );

  const checkpointHash = yield* Effect.tryPromise(() => getCheckpointShortHash(checkpoint)).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  const generationDetails = {
    checkpoint,
    ...(checkpointHash ? { checkpointHash } : {}),
    profile: profile.id,
    baseModel: profile.baseModel,
    engine: "comfyui",
    sampler,
    scheduler,
    steps,
    guidance,
    seed,
    width,
    height,
    positivePrompt: prompt,
    negativePrompt,
    denoise: input.referenceImagePath ? editStrength : 1,
    loras: activeLoras.map((lora) => ({ name: lora.name, path: lora.path, weight: lora.weight })),
  };

  const started = yield* Clock.currentTimeMillis;

  const wantsComfyUi = imageSettings.engine === "comfyui" || imageSettings.engine === "auto";
  if (wantsComfyUi) {
    const endpoint = (imageSettings.comfyUiEndpoint.trim() || "http://127.0.0.1:8188").replace(
      /\/+$/,
      "",
    );
    const comfyReachable = yield* comfyJson<unknown>(`${endpoint}/system_stats`).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (comfyReachable) {
      const fileName = (value: string) => value.replaceAll("\\", "/").split("/").at(-1) ?? value;
      const comfyRoot = imageSettings.comfyUiRootDirectory.trim();
      const referenceExtension = input.referenceImagePath
        ? localPathExtension(input.referenceImagePath) || ".png"
        : "";
      const referenceRelativeName = input.referenceImagePath
        ? `ShiryuGen/reference-${uuid}${referenceExtension}`
        : null;
      const referenceAbsolutePath = referenceRelativeName
        ? joinLocalPath(comfyRoot, "input", ...referenceRelativeName.split("/"))
        : null;

      const comfyAttempt = Effect.gen(function* () {
        if (input.referenceImagePath) {
          if (!comfyRoot || !isAbsoluteLocalPath(comfyRoot) || !referenceAbsolutePath) {
            return yield* new ImageGenerationError({
              message:
                "Set an absolute ComfyUI root directory before using reference-image workflows.",
            });
          }
          yield* fs
            .makeDirectory(localPathDirname(referenceAbsolutePath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ImageGenerationError({
                    message: `Could not prepare the ComfyUI reference-image input directory: ${cause.message}`,
                  }),
              ),
            );
          yield* fs.copyFile(input.referenceImagePath, referenceAbsolutePath).pipe(
            Effect.mapError(
              (cause) =>
                new ImageGenerationError({
                  message: `Could not stage the reference image for ComfyUI: ${cause.message}`,
                }),
            ),
          );
        }

        const loras = activeLoras.map((lora) => ({
          name: fileName(lora.path),
          weight: lora.weight,
        }));
        const workflow =
          input.referenceImagePath && referenceRelativeName
            ? compileImg2ImgWorkflow({
                checkpointName: fileName(checkpoint),
                referenceImageName: referenceRelativeName,
                width,
                height,
                prompt,
                negativePrompt: negativePrompt,
                steps,
                guidance,
                sampler,
                scheduler,
                seed,
                denoise: editStrength,
                loras,
                filenamePrefix: `ShiryuGen/${uuid}`,
              })
            : compileTxt2ImgWorkflow({
                checkpointName: fileName(checkpoint),
                prompt,
                negativePrompt: negativePrompt,
                width,
                height,
                steps,
                guidance,
                sampler,
                scheduler,
                seed,
                loras,
                filenamePrefix: `ShiryuGen/${uuid}`,
              });
        return yield* executeComfyWorkflowDirect({ endpoint, workflow, outputPath });
      }).pipe(
        referenceAbsolutePath
          ? Effect.ensuring(fs.remove(referenceAbsolutePath).pipe(Effect.catch(() => Effect.void)))
          : (effect) => effect,
      );

      yield* comfyAttempt;
      return {
        outputPath,
        generationDetails,
        model,
        width,
        height,
        steps,
        guidance,
        seed,
        elapsedMs: (yield* Clock.currentTimeMillis) - started,
      };
    }
    if (imageSettings.engine === "comfyui" || model === "perfect-anima" || model === "nova-anime") {
      return yield* new ImageGenerationError({
        message:
          imageSettings.engine === "comfyui"
            ? `Headless ComfyUI is not reachable at ${endpoint}.`
            : `The ${model} checkpoint requires Headless ComfyUI in this ShiryuGen setup, but ${endpoint} is not reachable.`,
      });
    }
  }

  const result = yield* runner
    .run({
      command: "python",
      args: ["-c", PYTHON_GENERATOR],
      stdin: encodeUnknownJson({
        checkpoint,
        sampler,
        scheduler,
        outputPath,
        prompt,
        negativePrompt: negativePrompt,
        width,
        height,
        steps,
        guidance,
        seed,
        editStrength,
        loras: activeLoras.map((lora) => ({ path: lora.path, weight: lora.weight })),
        ...(input.referenceImagePath ? { referenceImagePath: input.referenceImagePath } : {}),
      }),
      timeout: "3 minutes",
      maxOutputBytes: 256 * 1024,
      outputMode: "truncate",
      env: {
        ...process.env,
        CUDA_HOME: process.env.CUDA_HOME || "/opt/cuda",
        CUDA_PATH: process.env.CUDA_PATH || "/opt/cuda",
        PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True",
      },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ImageGenerationError({
            message: `Local image generator failed to start or timed out: ${cause.message}`,
          }),
      ),
    );

  if (
    result.code !== 0 ||
    !(yield* fs.exists(outputPath).pipe(Effect.orElseSucceed(() => false)))
  ) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`;
    const message = detail.includes("Failed to load CLIPTextModel")
      ? "The selected checkpoint is not compatible with ShiryuGen's Diffusers fallback. Enable/restart Headless ComfyUI or choose a Diffusers-compatible checkpoint."
      : detail.includes("CUDA out of memory") || detail.includes("OutOfMemoryError")
        ? "The local image generator ran out of GPU memory. Reduce image size/steps or close another GPU-heavy application and try again."
        : `Local image generation failed: ${detail.split("\n").at(-1)?.trim() || `exit code ${String(result.code)}`}`;
    return yield* new ImageGenerationError({ message });
  }

  return {
    outputPath,
    generationDetails: { ...generationDetails, engine: "diffusers" },
    model,
    width,
    height,
    steps,
    guidance,
    seed,
    elapsedMs: (yield* Clock.currentTimeMillis) - started,
  };
});

const handlers = {
  t3_generate_image: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.McpInvocationContext;
      return yield* generateLocalImage(input);
    }),
} satisfies Parameters<typeof ImageGenerationToolkit.toLayer>[0];

export const ImageGenerationToolkitHandlersLive = ImageGenerationToolkit.toLayer(handlers);
