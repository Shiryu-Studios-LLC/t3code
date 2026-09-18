import { describe, expect, it } from "vite-plus/test";

import {
  inferLocalImageModel,
  localImageAssistantCreatedAt,
  resolveLocalImageReferencePath,
} from "./LocalImageGeneration.ts";

it("sorts the local image assistant response after its user prompt", () => {
  expect(localImageAssistantCreatedAt("2026-09-14T23:11:20.000Z")).toBe("2026-09-14T23:11:20.001Z");
});

describe("resolveLocalImageReferencePath", () => {
  it("prefers the durable attachment copy when available", () => {
    expect(
      resolveLocalImageReferencePath({
        durablePath: "/attachments/generated.png",
        fallbackPath: "/generated_images/generated.png",
        fallbackExists: true,
      }),
    ).toBe("/attachments/generated.png");
  });

  it("falls back to the saved generated image for older attachments", () => {
    expect(
      resolveLocalImageReferencePath({
        durablePath: null,
        fallbackPath: "/generated_images/generated.png",
        fallbackExists: true,
      }),
    ).toBe("/generated_images/generated.png");
  });

  it("returns null when neither reference is available", () => {
    expect(
      resolveLocalImageReferencePath({
        durablePath: null,
        fallbackPath: "/generated_images/missing.png",
        fallbackExists: false,
      }),
    ).toBeNull();
  });
});

describe("inferLocalImageModel", () => {
  it("uses the mature checkpoint for clearly mature image prompts", () => {
    expect(
      inferLocalImageModel("can you create me a naked Kitsune Character in a very sexy pose"),
    ).toBe("nova-mature");
  });

  it("uses the furry checkpoint for non-mature furry and canine prompts", () => {
    expect(inferLocalImageModel("a detailed kitsune character in a moonlit forest")).toBe(
      "nova-furry",
    );
    expect(inferLocalImageModel("an anthropomorphic husky character in snow")).toBe("nova-furry");
    expect(inferLocalImageModel("a photorealistic husky portrait in snow")).toBe("nova-unreal");
  });

  it("uses the specialized anime and Pokemon checkpoints", () => {
    expect(inferLocalImageModel("anime heroine on a rooftop at sunset")).toBe("nova-anime");
    expect(inferLocalImageModel("Pikachu exploring a colorful forest")).toBe("nova-pkm");
  });

  it("falls back to the general realistic checkpoint", () => {
    expect(inferLocalImageModel("a cinematic sports car in neon rain")).toBe("nova-unreal");
  });
});

it("does not interpret an adult character's age as an erotic checkpoint request", () => {
  expect(inferLocalImageModel("anime young adult male, age 18, academy uniform")).toBe(
    "nova-anime",
  );
});
