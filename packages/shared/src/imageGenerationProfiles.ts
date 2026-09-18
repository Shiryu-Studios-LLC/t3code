/** Defaults are selected from the actual checkpoint, never a global character setting. */
export function resolveImageGenerationProfile(checkpoint: string) {
  const name = checkpoint.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const baseline = {
    id: "sdxl-default",
    baseModel: "SDXL / custom",
    sampler: "dpmpp_2m",
    scheduler: "karras",
    steps: 28,
    guidance: 5,
    width: 768,
    height: 1024,
    positivePrefix: "",
    negativeBaseline: "worst quality, low quality, lowres, blurry, jpeg artifacts",
  };
  if (/pony/.test(name)) {
    return {
      ...baseline,
      id: "pony",
      baseModel: "Pony XL",
      sampler: "euler_ancestral",
      scheduler: "normal",
      positivePrefix: "score_9, score_8_up, score_7_up, source_anime",
      negativeBaseline: "score_4, score_3, score_2, score_1, lowres, blurry",
    };
  }
  if (/nova.?anime.*(?:il|illustrious)|^nova-anime$/.test(name)) {
    return {
      ...baseline,
      id: "nova-anime-illustrious",
      baseModel: "Illustrious XL",
      sampler: "euler_ancestral",
      scheduler: "normal",
      steps: 26,
      guidance: 4.5,
      positivePrefix: "masterpiece, best quality, amazing quality, very aesthetic, newest",
    };
  }
  if (/counterfeit|meinamix|revanimated|sd.?1[._ -]?5/.test(name)) {
    return {
      ...baseline,
      id: "sd15",
      baseModel: "SD 1.5",
      width: 512,
      height: 768,
      guidance: 7,
      positivePrefix: "masterpiece, best quality",
    };
  }
  if (/perfect.*anima/.test(name)) {
    return { ...baseline, id: "perfect-anima", baseModel: "Custom (verify model card)" };
  }
  return baseline;
}
