import { expect, it } from "vite-plus/test";
import { ThreadId, type ChatImageAttachment } from "@t3tools/contracts";
import { buildGeneratedImageInput } from "./generatedImageInput";

const image: ChatImageAttachment = {
  type: "image",
  id: "render-1",
  name: "render.png",
  mimeType: "image/png",
  sizeBytes: 10,
  generationDetails: {
    checkpoint: "/models/novaAnimeXL_ilV190.safetensors",
    profile: "nova-anime-illustrious",
    baseModel: "Illustrious XL",
    engine: "comfyui",
    sampler: "euler_ancestral",
    scheduler: "normal",
    width: 768,
    height: 1024,
    steps: 26,
    guidance: 4.5,
    seed: 42,
    positivePrompt: "1boy, black hair",
    negativePrompt: "aura",
    denoise: 1,
    loras: [],
    character: "Kashiro",
    sceneMode: "first-canon-reference",
    modelProfile: "nova-anime-illustrious",
    policyVersion: "shiryugen-policy-v2",
    referenceState: "none",
    formatterModel: "deterministic canon compiler",
    formatterFallback: false,
    promptSource: "deterministic",
  },
};
it("regenerates using the actual checkpoint, prompts and empty LoRA stack with a fresh seed", () => {
  const input = buildGeneratedImageInput(ThreadId.make("thread-1"), image);
  expect(input).toMatchObject({
    model: "custom",
    checkpointPath: image.generationDetails?.checkpoint,
    prompt: "1boy, black hair",
    negativePrompt: "aura",
    steps: 26,
    guidance: 4.5,
    loras: [],
    skipPromptRefinement: true,
    sampler: "euler_ancestral",
    scheduler: "normal",
    shiryuGenMetadata: {
      character: "Kashiro",
      sceneMode: "first-canon-reference",
      modelProfile: "nova-anime-illustrious",
      policyVersion: "shiryugen-policy-v2",
      referenceState: "none",
      formatterModel: "deterministic canon compiler",
      formatterFallback: false,
      promptSource: "deterministic",
    },
  });
  expect(input?.seed).toBeUndefined();
  expect(input?.referenceAttachmentId).toBeUndefined();
});
it("edits the selected attachment with its own model settings", () => {
  expect(buildGeneratedImageInput(ThreadId.make("thread-1"), image, "  turn left  ")).toMatchObject(
    {
      prompt: "turn left",
      referenceAttachmentId: "render-1",
      loras: [],
      checkpointPath: image.generationDetails?.checkpoint,
    },
  );
  expect(
    buildGeneratedImageInput(ThreadId.make("thread-1"), image, "turn left")?.shiryuGenMetadata,
  ).toBeUndefined();
  expect(buildGeneratedImageInput(ThreadId.make("thread-1"), image, " ")).toBeNull();
});
