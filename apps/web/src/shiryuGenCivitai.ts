import type {
  ShiryuGenCivitaiConfigStatus,
  ShiryuGenCivitaiInstallResult,
  ShiryuGenCivitaiInstallTask,
  ShiryuGenCivitaiInstallTasksResult,
  ShiryuGenCivitaiSearchInput,
  ShiryuGenCivitaiSearchResult,
  ShiryuGenCivitaiUninstallResult,
  ShiryuGenInstalledModelsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";

export async function readCivitaiConfig(): Promise<ShiryuGenCivitaiConfigStatus> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.shiryuGen.civitaiConfig({ headers: {} })),
    ),
  );
}

export async function updateCivitaiApiKey(apiKey: string): Promise<ShiryuGenCivitaiConfigStatus> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.shiryuGen.updateCivitaiConfig({
          headers: {},
          payload: { apiKey },
        }),
      ),
    ),
  );
}

export async function searchCivitaiModels(
  input: ShiryuGenCivitaiSearchInput,
): Promise<ShiryuGenCivitaiSearchResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.shiryuGen.searchCivitaiModels({
          headers: {},
          payload: input,
        }),
      ),
    ),
  );
}

export async function readInstalledCivitaiModels(): Promise<ShiryuGenInstalledModelsResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.shiryuGen.installedCivitaiModels({ headers: {} })),
    ),
  );
}

export async function installCivitaiModel(
  modelId: number,
  versionId: number,
): Promise<ShiryuGenCivitaiInstallResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.shiryuGen.installCivitaiModel({
          headers: {},
          payload: { modelId, versionId },
        }),
      ),
    ),
  );
}

export async function queueCivitaiModelInstall(
  modelId: number,
  versionId: number,
): Promise<ShiryuGenCivitaiInstallTask> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.shiryuGen.queueCivitaiModelInstall({
          headers: {},
          payload: { modelId, versionId },
        }),
      ),
    ),
  );
}

export async function readCivitaiModelInstallTasks(): Promise<ShiryuGenCivitaiInstallTasksResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.shiryuGen.civitaiModelInstallTasks({ headers: {} })),
    ),
  );
}

export async function uninstallCivitaiModel(
  modelId: number,
): Promise<ShiryuGenCivitaiUninstallResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.shiryuGen.uninstallCivitaiModel({
          headers: {},
          payload: { modelId },
        }),
      ),
    ),
  );
}
