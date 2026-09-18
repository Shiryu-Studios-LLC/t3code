import type {
  ShiryuGenCivitaiInstallTask,
  ShiryuGenCivitaiModelSummary,
  ShiryuGenInstalledModel,
} from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import {
  CivitaiDownloadQueueSummary,
  CivitaiModelCard,
  mergeCompletedCivitaiInstall,
} from "./ModelsPage";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function normalizedText(node: ReactNode): string {
  return textOf(node).replace(/\s+/g, " ").trim();
}

function model(id: number): ShiryuGenCivitaiModelSummary {
  return {
    id,
    name: `Model ${id}`,
    type: "Checkpoint",
    creatorName: "Shiryu",
    versionId: id * 10,
    versionName: `Version ${id}`,
    baseModel: "SDXL 1.0",
    trainedWords: [],
    previewImageUrl: null,
    downloadUrl: `https://example.test/${id}`,
    primaryFileName: `model-${id}.safetensors`,
    primaryFileSizeBytes: 100,
    primaryFileSha256: null,
    installSupported: true,
    installTarget: "checkpoints",
    downloadCount: 10,
    favoriteCount: 2,
    rating: 4.5,
  };
}

function installed(modelId: number, versionId = modelId * 10): ShiryuGenInstalledModel {
  return {
    modelId,
    versionId,
    modelName: `Model ${modelId}`,
    versionName: `Version ${versionId}`,
    type: "Checkpoint",
    baseModel: "SDXL 1.0",
    fileName: `model-${modelId}.safetensors`,
    relativePath: `models/checkpoints/model-${modelId}.safetensors`,
    installTarget: "checkpoints",
    sha256: null,
    fileSizeBytes: 100,
    installedAt: "2026-09-15T00:00:00.000Z",
  };
}

function task(
  modelId: number,
  status: ShiryuGenCivitaiInstallTask["status"],
  overrides: Partial<ShiryuGenCivitaiInstallTask> = {},
): ShiryuGenCivitaiInstallTask {
  return {
    id: `task-${modelId}`,
    modelId,
    versionId: modelId * 10,
    status,
    bytesDownloaded: 0,
    totalBytes: 100,
    progress: null,
    error: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-09-15T00:00:01.000Z",
    finishedAt: null,
    installed: null,
    replacedVersionId: null,
    ...overrides,
  };
}

const noop = () => {};

describe("ShiryuGen CivitAI model downloads", () => {
  it("renders the active/queued download summary and configured parallel limit", () => {
    const text = normalizedText(
      CivitaiDownloadQueueSummary({ activeCount: 2, queuedCount: 1, maxConcurrency: 3 }),
    );
    expect(text).toContain("Downloads: 2 active, 1 queued");
    expect(text).toContain("Max parallel downloads: 3");
  });

  it("lets multiple model cards render independent active states", () => {
    const downloading = CivitaiModelCard({
      model: model(1),
      installed: null,
      task: task(1, "downloading", { bytesDownloaded: 38, progress: 38 }),
      removing: false,
      onInstall: noop,
      onRemove: noop,
      onUse: noop,
    });
    const verifying = CivitaiModelCard({
      model: model(2),
      installed: null,
      task: task(2, "verifying", { bytesDownloaded: 100, progress: 100 }),
      removing: false,
      onInstall: noop,
      onRemove: noop,
      onUse: noop,
    });

    expect(normalizedText(downloading)).toContain("Downloading 38%");
    expect(normalizedText(verifying)).toContain("Verifying");
  });

  it("merges a completed task into installed state without replacing unrelated models", () => {
    const previous = installed(1, 9);
    const unrelated = installed(2, 20);
    const replacement = installed(1, 10);
    const completed = task(1, "completed", {
      progress: 100,
      installed: replacement,
      finishedAt: "2026-09-15T00:00:02.000Z",
      replacedVersionId: 9,
    });

    expect(mergeCompletedCivitaiInstall([previous, unrelated], completed)).toEqual([
      unrelated,
      replacement,
    ]);
  });

  it("renders a failed task with its error and a retry action", () => {
    const failed = CivitaiModelCard({
      model: model(3),
      installed: null,
      task: task(3, "failed", {
        error: "Checksum mismatch",
        finishedAt: "2026-09-15T00:00:02.000Z",
      }),
      removing: false,
      onInstall: noop,
      onRemove: noop,
      onUse: noop,
    });
    const text = normalizedText(failed);

    expect(text).toContain("Failed · Checksum mismatch");
    expect(text).toContain("Retry");
  });
});
