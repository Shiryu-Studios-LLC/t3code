export interface CivitaiFileMetadata {
  readonly name: string;
  readonly primary?: boolean | undefined;
  readonly sizeKB?: number | undefined;
  readonly pickleScanResult?: string | null | undefined;
  readonly virusScanResult?: string | null | undefined;
  readonly hashes?: { readonly SHA256?: string | undefined } | undefined;
  readonly downloadUrl?: string | null | undefined;
}

const VIDEO_BASE_MODEL_MARKERS = [
  "wan",
  "hunyuan video",
  "hunyuanvideo",
  "ltx video",
  "ltxv",
  "mochi",
  "cogvideo",
  "cosmos",
] as const;

export function resolveCivitaiInstallTarget(
  modelType: string,
  baseModel: string | null,
): string | null {
  const normalizedType = modelType.trim().toLowerCase();
  const normalizedBaseModel = baseModel?.trim().toLowerCase() ?? "";

  if (normalizedType === "lora" || normalizedType === "locon" || normalizedType === "dora") {
    return "loras";
  }
  if (normalizedType === "controlnet") return "controlnet";
  if (normalizedType === "textualinversion") return "embeddings";
  if (normalizedType === "vae") return "vae";
  if (normalizedType === "upscaler") return "upscale_models";
  if (normalizedType === "hypernetwork") return "hypernetworks";
  if (normalizedType === "motionmodule") return "animatediff_models";
  if (normalizedType === "checkpoint") {
    return VIDEO_BASE_MODEL_MARKERS.some((marker) => normalizedBaseModel.includes(marker))
      ? "diffusion_models"
      : "checkpoints";
  }
  return null;
}

export function selectPrimaryCivitaiFile(
  files: ReadonlyArray<CivitaiFileMetadata> | undefined,
): CivitaiFileMetadata | null {
  if (!files || files.length === 0) return null;
  return files.find((file) => file.primary) ?? files[0] ?? null;
}

export function isCivitaiFileBlockedByScan(file: CivitaiFileMetadata): boolean {
  const blocked = new Set(["danger", "error"]);
  return (
    blocked.has(file.pickleScanResult?.trim().toLowerCase() ?? "") ||
    blocked.has(file.virusScanResult?.trim().toLowerCase() ?? "")
  );
}

export function sanitizeModelFileName(fileName: string, fallback: string): string {
  const normalized = fileName.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const safe = normalized.replace(/[^a-zA-Z0-9._()\[\] +-]/g, "_");
  if (!safe || safe === "." || safe === "..") return fallback;
  return safe;
}
