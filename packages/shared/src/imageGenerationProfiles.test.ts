import { expect, it } from "vite-plus/test";
import { resolveImageGenerationProfile } from "./imageGenerationProfiles.js";

it("uses the actual checkpoint family for native prompting and sampler defaults", () => {
  expect(resolveImageGenerationProfile("/models/novaAnimeXL_ilV190.safetensors")).toMatchObject({
    sampler: "euler_ancestral",
    scheduler: "normal",
    steps: 26,
    guidance: 4.5,
    baseModel: "Illustrious XL",
  });
  expect(
    resolveImageGenerationProfile("C:\\models\\ponyDiffusionV6XL.safetensors").positivePrefix,
  ).toContain("score_9");
  expect(resolveImageGenerationProfile("meinamix_v12Final.safetensors")).toMatchObject({
    baseModel: "SD 1.5",
    width: 512,
    height: 768,
  });
  expect(resolveImageGenerationProfile("unknown-model.safetensors").positivePrefix).toBe("");
  expect(resolveImageGenerationProfile("perfectrsbmixAnimaAIO_gamma.safetensors").id).toBe(
    "perfect-anima",
  );
});
