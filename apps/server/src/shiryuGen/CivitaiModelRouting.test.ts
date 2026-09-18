import { describe, expect, it } from "vite-plus/test";

import {
  isCivitaiFileBlockedByScan,
  resolveCivitaiInstallTarget,
  sanitizeModelFileName,
  selectPrimaryCivitaiFile,
} from "./CivitaiModelRouting.ts";

describe("CivitaiModelRouting", () => {
  it("routes common CivitAI model types into ComfyUI model folders", () => {
    expect(resolveCivitaiInstallTarget("Checkpoint", "SDXL 1.0")).toBe("checkpoints");
    expect(resolveCivitaiInstallTarget("LORA", "Illustrious")).toBe("loras");
    expect(resolveCivitaiInstallTarget("Controlnet", "SDXL 1.0")).toBe("controlnet");
    expect(resolveCivitaiInstallTarget("TextualInversion", "SD 1.5")).toBe("embeddings");
    expect(resolveCivitaiInstallTarget("VAE", "SDXL 1.0")).toBe("vae");
    expect(resolveCivitaiInstallTarget("Upscaler", null)).toBe("upscale_models");
  });

  it("routes known video diffusion checkpoints separately from full checkpoints", () => {
    expect(resolveCivitaiInstallTarget("Checkpoint", "Wan Video 2.2 I2V-A14B")).toBe(
      "diffusion_models",
    );
    expect(resolveCivitaiInstallTarget("Checkpoint", "Hunyuan Video")).toBe("diffusion_models");
    expect(resolveCivitaiInstallTarget("Checkpoint", "LTX Video")).toBe("diffusion_models");
  });

  it("keeps unknown model types unsupported instead of guessing a folder", () => {
    expect(resolveCivitaiInstallTarget("Poses", "SDXL 1.0")).toBeNull();
  });

  it("selects the primary file and blocks dangerous scan results", () => {
    const selected = selectPrimaryCivitaiFile([
      { name: "training.zip" },
      { name: "model.safetensors", primary: true, virusScanResult: "Success" },
    ]);
    expect(selected?.name).toBe("model.safetensors");
    expect(
      isCivitaiFileBlockedByScan({ name: "safe.safetensors", virusScanResult: "Success" }),
    ).toBe(false);
    expect(isCivitaiFileBlockedByScan({ name: "bad.ckpt", pickleScanResult: "Danger" })).toBe(true);
  });

  it("sanitizes a remote filename down to one safe basename", () => {
    expect(sanitizeModelFileName("../../evil/model?.safetensors", "fallback.safetensors")).toBe(
      "model_.safetensors",
    );
  });
});
