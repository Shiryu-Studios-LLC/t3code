import { resolveImageGenerationProfile } from "@t3tools/shared/imageGenerationProfiles";

export interface ComfyWorkflowNode {
  readonly class_type: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly _meta?: { readonly title: string };
}

export type ComfyApiWorkflow = Readonly<Record<string, ComfyWorkflowNode>>;

export interface ComfyLoraInput {
  readonly name: string;
  readonly weight: number;
}

export interface CompileTxt2ImgWorkflowInput {
  readonly checkpointName: string;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  readonly guidance: number;
  readonly sampler?: string;
  readonly scheduler?: string;
  readonly seed: number;
  readonly loras?: ReadonlyArray<ComfyLoraInput>;
  readonly filenamePrefix?: string;
}

export interface CompileImg2ImgWorkflowInput {
  readonly checkpointName: string;
  readonly referenceImageName: string;
  readonly width?: number;
  readonly height?: number;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly steps: number;
  readonly guidance: number;
  readonly sampler?: string;
  readonly scheduler?: string;
  readonly seed: number;
  readonly denoise: number;
  readonly loras?: ReadonlyArray<ComfyLoraInput>;
  readonly filenamePrefix?: string;
}

/**
 * Compile ShiryuGen's baseline text-to-image intent into ComfyUI's API workflow format.
 * The graph deliberately uses only core nodes so capability validation can treat this
 * as the minimum compatible workflow before optional ControlNet/IPAdapter/video nodes
 * are layered in by later compilers.
 */
export function compileTxt2ImgWorkflow(input: CompileTxt2ImgWorkflowInput): ComfyApiWorkflow {
  const workflow: Record<string, ComfyWorkflowNode> = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: input.checkpointName },
      _meta: { title: "ShiryuGen Checkpoint" },
    },
  };

  let modelRef: readonly [string, number] = ["1", 0];
  let clipRef: readonly [string, number] = ["1", 1];
  let nextNodeId = 10;
  for (const lora of input.loras ?? []) {
    const nodeId = String(nextNodeId++);
    workflow[nodeId] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.name,
        strength_model: lora.weight,
        strength_clip: lora.weight,
        model: modelRef,
        clip: clipRef,
      },
      _meta: { title: `ShiryuGen LoRA · ${lora.name}` },
    };
    modelRef = [nodeId, 0];
    clipRef = [nodeId, 1];
  }

  workflow["2"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: input.prompt, clip: clipRef },
    _meta: { title: "Positive Prompt" },
  };
  workflow["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: input.negativePrompt, clip: clipRef },
    _meta: { title: "Negative Prompt" },
  };
  workflow["4"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: input.width, height: input.height, batch_size: 1 },
    _meta: { title: "Canvas" },
  };
  workflow["5"] = {
    class_type: "KSampler",
    inputs: {
      seed: input.seed,
      steps: input.steps,
      cfg: input.guidance,
      sampler_name:
        input.sampler?.trim() || resolveImageGenerationProfile(input.checkpointName).sampler,
      scheduler:
        input.scheduler?.trim() || resolveImageGenerationProfile(input.checkpointName).scheduler,
      denoise: 1,
      model: modelRef,
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
    },
    _meta: { title: "ShiryuGen Sampler" },
  };
  workflow["6"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["5", 0], vae: ["1", 2] },
    _meta: { title: "Decode" },
  };
  workflow["7"] = {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: input.filenamePrefix?.trim() || "ShiryuGen",
      images: ["6", 0],
    },
    _meta: { title: "ShiryuGen Output" },
  };

  return workflow;
}

export function compileImg2ImgWorkflow(input: CompileImg2ImgWorkflowInput): ComfyApiWorkflow {
  const workflow: Record<string, ComfyWorkflowNode> = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: input.checkpointName },
      _meta: { title: "ShiryuGen Checkpoint" },
    },
  };

  let modelRef: readonly [string, number] = ["1", 0];
  let clipRef: readonly [string, number] = ["1", 1];
  let nextNodeId = 10;
  for (const lora of input.loras ?? []) {
    const nodeId = String(nextNodeId++);
    workflow[nodeId] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.name,
        strength_model: lora.weight,
        strength_clip: lora.weight,
        model: modelRef,
        clip: clipRef,
      },
      _meta: { title: `ShiryuGen LoRA · ${lora.name}` },
    };
    modelRef = [nodeId, 0];
    clipRef = [nodeId, 1];
  }

  workflow["2"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: input.prompt, clip: clipRef },
    _meta: { title: "Positive Prompt" },
  };
  workflow["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: input.negativePrompt, clip: clipRef },
    _meta: { title: "Negative Prompt" },
  };
  workflow["4"] = {
    class_type: "LoadImage",
    inputs: { image: input.referenceImageName },
    _meta: { title: "Character / Reference Image" },
  };
  if (input.width && input.height) {
    workflow["9"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["4", 0],
        upscale_method: "lanczos",
        width: input.width,
        height: input.height,
        crop: "disabled",
      },
    };
  }
  workflow["5"] = {
    class_type: "VAEEncode",
    inputs: { pixels: [input.width && input.height ? "9" : "4", 0], vae: ["1", 2] },
    _meta: { title: "Encode Reference" },
  };
  workflow["6"] = {
    class_type: "KSampler",
    inputs: {
      seed: input.seed,
      steps: input.steps,
      cfg: input.guidance,
      sampler_name:
        input.sampler?.trim() || resolveImageGenerationProfile(input.checkpointName).sampler,
      scheduler:
        input.scheduler?.trim() || resolveImageGenerationProfile(input.checkpointName).scheduler,
      denoise: input.denoise,
      model: modelRef,
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["5", 0],
    },
    _meta: { title: "ShiryuGen Reference Sampler" },
  };
  workflow["7"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: ["1", 2] },
    _meta: { title: "Decode" },
  };
  workflow["8"] = {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: input.filenamePrefix?.trim() || "ShiryuGen",
      images: ["7", 0],
    },
    _meta: { title: "ShiryuGen Output" },
  };

  return workflow;
}

export const SHIRYUGEN_TXT2IMG_REQUIRED_COMFY_NODES = [
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "EmptyLatentImage",
  "KSampler",
  "VAEDecode",
  "SaveImage",
] as const;

export const SHIRYUGEN_IMG2IMG_REQUIRED_COMFY_NODES = [
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "LoadImage",
  "VAEEncode",
  "KSampler",
  "VAEDecode",
  "SaveImage",
] as const;

export function missingRequiredNodes(
  availableNodeNames: ReadonlySet<string>,
  workflow: ComfyApiWorkflow,
): string[] {
  return [...new Set(Object.values(workflow).map((node) => node.class_type))].filter(
    (nodeName) => !availableNodeNames.has(nodeName),
  );
}
