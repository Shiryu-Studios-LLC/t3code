import { describe, expect, it } from "vite-plus/test";

import {
  compileImg2ImgWorkflow,
  compileTxt2ImgWorkflow,
  missingRequiredNodes,
} from "./ComfyWorkflowCompiler.ts";

describe("ComfyWorkflowCompiler", () => {
  it("builds a core text-to-image API workflow", () => {
    const workflow = compileTxt2ImgWorkflow({
      checkpointName: "characterXL.safetensors",
      prompt: "Rin standing in a moonlit courtyard",
      negativePrompt: "blurry",
      width: 1024,
      height: 768,
      steps: 28,
      guidance: 5.5,
      seed: 42,
    });

    expect(workflow["1"]).toMatchObject({
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "characterXL.safetensors" },
    });
    expect(workflow["5"]).toMatchObject({
      class_type: "KSampler",
      inputs: {
        seed: 42,
        steps: 28,
        cfg: 5.5,
        model: ["1", 0],
      },
    });
    expect(workflow["7"]).toMatchObject({
      class_type: "SaveImage",
      inputs: { filename_prefix: "ShiryuGen", images: ["6", 0] },
    });
  });

  it("chains LoRAs into both model and CLIP inputs", () => {
    const workflow = compileTxt2ImgWorkflow({
      checkpointName: "characterXL.safetensors",
      prompt: "portrait",
      negativePrompt: "",
      width: 768,
      height: 768,
      steps: 24,
      guidance: 5,
      seed: 7,
      loras: [
        { name: "rin-identity.safetensors", weight: 0.9 },
        { name: "series-style.safetensors", weight: 0.65 },
      ],
    });

    expect(workflow["10"]).toMatchObject({
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: "rin-identity.safetensors",
        strength_model: 0.9,
        strength_clip: 0.9,
      },
    });
    expect(workflow["11"]).toMatchObject({
      class_type: "LoraLoader",
      inputs: { model: ["10", 0], clip: ["10", 1] },
    });
    expect(workflow["2"]?.inputs.clip).toEqual(["11", 1]);
    expect(workflow["5"]?.inputs.model).toEqual(["11", 0]);
  });

  it("builds a core reference-image workflow with configurable denoise", () => {
    const workflow = compileImg2ImgWorkflow({
      checkpointName: "characterXL.safetensors",
      referenceImageName: "ShiryuGen/rin-canon.png",
      prompt: "Rin walking through a rainy market",
      negativePrompt: "blurry",
      steps: 30,
      guidance: 5.5,
      seed: 99,
      denoise: 0.42,
      loras: [{ name: "series-style.safetensors", weight: 0.7 }],
    });

    expect(workflow["4"]).toMatchObject({
      class_type: "LoadImage",
      inputs: { image: "ShiryuGen/rin-canon.png" },
    });
    expect(workflow["5"]).toMatchObject({
      class_type: "VAEEncode",
      inputs: { pixels: ["4", 0], vae: ["1", 2] },
    });
    expect(workflow["6"]).toMatchObject({
      class_type: "KSampler",
      inputs: {
        denoise: 0.42,
        latent_image: ["5", 0],
        model: ["10", 0],
      },
    });
    expect(workflow["8"]).toMatchObject({
      class_type: "SaveImage",
      inputs: { images: ["7", 0] },
    });
  });

  it("reports unavailable nodes before execution", () => {
    const workflow = compileTxt2ImgWorkflow({
      checkpointName: "characterXL.safetensors",
      prompt: "portrait",
      negativePrompt: "",
      width: 768,
      height: 768,
      steps: 24,
      guidance: 5,
      seed: 7,
      loras: [{ name: "identity.safetensors", weight: 0.8 }],
    });
    const available = new Set([
      "CheckpointLoaderSimple",
      "CLIPTextEncode",
      "EmptyLatentImage",
      "KSampler",
      "VAEDecode",
      "SaveImage",
    ]);

    expect(missingRequiredNodes(available, workflow)).toEqual(["LoraLoader"]);
  });
});

it("uses Nova Anime's profile for both text and reference workflows", () => {
  const input = {
    checkpointName: "novaAnimeXL_ilV190.safetensors",
    prompt: "1boy",
    negativePrompt: "",
    steps: 26,
    guidance: 4.5,
    seed: 42,
    width: 768,
    height: 1024,
  };
  const text = compileTxt2ImgWorkflow(input);
  expect(text["1"]?.inputs.ckpt_name).toBe("novaAnimeXL_ilV190.safetensors");
  const reference = compileImg2ImgWorkflow({
    ...input,
    referenceImageName: "canon.png",
    denoise: 0.4,
  });
  expect(text["5"]?.inputs).toMatchObject({ sampler_name: "euler_ancestral", scheduler: "normal" });
  expect(reference["6"]?.inputs).toMatchObject({
    sampler_name: "euler_ancestral",
    scheduler: "normal",
  });
});
