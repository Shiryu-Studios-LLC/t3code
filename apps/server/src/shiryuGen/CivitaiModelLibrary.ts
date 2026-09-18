import type {
  ShiryuGenCivitaiInstallResult,
  ShiryuGenCivitaiUninstallResult,
  ShiryuGenInstalledModel,
  ShiryuGenInstalledModelsResult,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CIVITAI_API_KEY_SECRET } from "./CivitaiService.ts";
import {
  isCivitaiFileBlockedByScan,
  resolveCivitaiInstallTarget,
  sanitizeModelFileName,
  selectPrimaryCivitaiFile,
} from "./CivitaiModelRouting.ts";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";
const MANIFEST_FILE_NAME = "installed-models.json";

const CivitaiFile = Schema.Struct({
  id: Schema.optional(Schema.Number),
  name: Schema.String,
  type: Schema.optional(Schema.String),
  sizeKB: Schema.optional(Schema.Number),
  primary: Schema.optional(Schema.Boolean),
  pickleScanResult: Schema.optional(Schema.NullOr(Schema.String)),
  virusScanResult: Schema.optional(Schema.NullOr(Schema.String)),
  downloadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  hashes: Schema.optional(
    Schema.Struct({
      SHA256: Schema.optional(Schema.String),
    }),
  ),
});

const CivitaiVersionDetails = Schema.Struct({
  id: Schema.Number,
  modelId: Schema.Number,
  name: Schema.String,
  baseModel: Schema.optional(Schema.NullOr(Schema.String)),
  downloadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.Struct({
    name: Schema.String,
    type: Schema.String,
  }),
  files: Schema.optional(Schema.Array(CivitaiFile)),
});

const InstalledModelManifest = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(
    Schema.Struct({
      modelId: Schema.Number,
      versionId: Schema.Number,
      modelName: Schema.String,
      versionName: Schema.String,
      type: Schema.String,
      baseModel: Schema.NullOr(Schema.String),
      fileName: Schema.String,
      relativePath: Schema.String,
      installTarget: Schema.String,
      sha256: Schema.NullOr(Schema.String),
      fileSizeBytes: Schema.Number,
      installedAt: Schema.String,
    }),
  ),
});

export type InstalledModelManifest = typeof InstalledModelManifest.Type;

export class CivitaiModelLibraryError extends Schema.TaggedErrorClass<CivitaiModelLibraryError>()(
  "CivitaiModelLibraryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const makeSerializedManifestMutator = Effect.fn(
  "CivitaiModelLibrary.makeSerializedManifestMutator",
)(function* (input: {
  readonly read: (root: string) => Effect.Effect<InstalledModelManifest, CivitaiModelLibraryError>;
  readonly write: (
    root: string,
    manifest: InstalledModelManifest,
  ) => Effect.Effect<void, CivitaiModelLibraryError>;
}) {
  const lock = yield* Semaphore.make(1);
  return <A>(
    root: string,
    mutate: (
      manifest: InstalledModelManifest,
    ) => Effect.Effect<readonly [InstalledModelManifest, A], CivitaiModelLibraryError>,
  ): Effect.Effect<A, CivitaiModelLibraryError> =>
    lock.withPermit(
      Effect.gen(function* () {
        const manifest = yield* input.read(root);
        const [nextManifest, result] = yield* mutate(manifest);
        yield* input.write(root, nextManifest);
        return result;
      }),
    );
});

export type CivitaiModelInstallProgressStatus = "downloading" | "verifying" | "installing";

export interface CivitaiModelInstallProgress {
  readonly status: CivitaiModelInstallProgressStatus;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
}

export type CivitaiModelInstallProgressReporter = (
  progress: CivitaiModelInstallProgress,
) => Effect.Effect<void>;

function normalizeSha256(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0]!;
  for (let index = 0; index < units.length; index += 1) {
    unit = units[index]!;
    if (size < 1024 || index === units.length - 1) break;
    size /= 1024;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

export class CivitaiModelLibrary extends Context.Service<
  CivitaiModelLibrary,
  {
    readonly listInstalled: () => Effect.Effect<
      ShiryuGenInstalledModelsResult,
      CivitaiModelLibraryError
    >;
    readonly install: (
      modelId: number,
      versionId: number,
      onProgress?: CivitaiModelInstallProgressReporter,
    ) => Effect.Effect<ShiryuGenCivitaiInstallResult, CivitaiModelLibraryError>;
    readonly uninstall: (
      modelId: number,
    ) => Effect.Effect<ShiryuGenCivitaiUninstallResult, CivitaiModelLibraryError>;
  }
>()("t3/shiryuGen/CivitaiModelLibrary") {
  static readonly layer = Layer.effect(
    CivitaiModelLibrary,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const settingsService = yield* ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const httpClient = yield* HttpClient.HttpClient;
      const textDecoder = new TextDecoder();

      const readApiKey = Effect.fn("CivitaiModelLibrary.readApiKey")(function* () {
        const secret = yield* secrets.get(CIVITAI_API_KEY_SECRET).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not read the stored CivitAI API key.",
                cause,
              }),
          ),
        );
        return Option.isSome(secret) ? textDecoder.decode(secret.value).trim() : "";
      });

      const resolveRoot = Effect.fn("CivitaiModelLibrary.resolveRoot")(function* () {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not read ShiryuGen model-library settings.",
                cause,
              }),
          ),
        );
        const root = settings.imageGeneration.comfyUiRootDirectory.trim();
        if (!root || !path.isAbsolute(root)) {
          return yield* new CivitaiModelLibraryError({
            message:
              "Set an absolute ComfyUI root directory in ShiryuGen Image Generation settings.",
          });
        }
        return path.resolve(root);
      });

      const manifestPath = (root: string) => path.join(root, ".shiryugen", MANIFEST_FILE_NAME);

      const readManifest = Effect.fn("CivitaiModelLibrary.readManifest")(function* (
        root: string,
      ): Effect.fn.Return<InstalledModelManifest, CivitaiModelLibraryError> {
        const raw = yield* fs
          .readFileString(manifestPath(root))
          .pipe(Effect.orElseSucceed(() => ""));
        if (!raw.trim()) return { version: 1, items: [] };
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledModelManifest))(
          raw,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "The ShiryuGen model install manifest is invalid.",
                cause,
              }),
          ),
        );
      });

      const writeManifest = Effect.fn("CivitaiModelLibrary.writeManifest")(function* (
        root: string,
        manifest: InstalledModelManifest,
      ) {
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(InstalledModelManifest))(
          manifest,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not serialize the ShiryuGen model install manifest.",
                cause,
              }),
          ),
        );
        const target = manifestPath(root);
        const directory = path.dirname(target);
        yield* fs.makeDirectory(directory, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not create the ShiryuGen model manifest directory.",
                cause,
              }),
          ),
        );
        const uuid = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not allocate a temporary model manifest path.",
                cause,
              }),
          ),
        );
        const temp = `${target}.${uuid}.tmp`;
        yield* fs.writeFileString(temp, `${json}\n`).pipe(
          Effect.flatMap(() => fs.rename(temp, target)),
          Effect.catch((cause) =>
            fs.remove(temp).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(
                Effect.fail(
                  new CivitaiModelLibraryError({
                    message: "Could not save the ShiryuGen model install manifest.",
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      });

      const mutateManifest = yield* makeSerializedManifestMutator({
        read: readManifest,
        write: writeManifest,
      });

      const resolveInstalledAbsolutePath = (
        root: string,
        installed: Pick<ShiryuGenInstalledModel, "relativePath">,
      ): string | null => {
        const modelsRoot = path.resolve(root, "models");
        const candidate = path.resolve(root, installed.relativePath);
        const prefix = modelsRoot.endsWith(path.sep) ? modelsRoot : `${modelsRoot}${path.sep}`;
        return candidate.startsWith(prefix) ? candidate : null;
      };

      const listInstalled = Effect.fn("CivitaiModelLibrary.listInstalled")(function* () {
        const root = yield* resolveRoot();
        const manifest = yield* readManifest(root);
        const existing: ShiryuGenInstalledModel[] = [];
        for (const item of manifest.items) {
          const absolutePath = resolveInstalledAbsolutePath(root, item);
          if (!absolutePath) continue;
          const exists = yield* fs.exists(absolutePath).pipe(Effect.orElseSucceed(() => false));
          if (exists) existing.push(item);
        }
        return { items: existing } satisfies ShiryuGenInstalledModelsResult;
      });

      const fetchVersion = Effect.fn("CivitaiModelLibrary.fetchVersion")(function* (
        versionId: number,
      ) {
        const apiKey = yield* readApiKey();
        let request = HttpClientRequest.get(`${CIVITAI_API_BASE}/model-versions/${versionId}`);
        if (apiKey) request = HttpClientRequest.bearerToken(apiKey)(request);
        return yield* httpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CivitaiVersionDetails)),
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: `Could not load CivitAI model version ${versionId}.`,
                cause,
              }),
          ),
        );
      });

      const streamDownload = Effect.fn("CivitaiModelLibrary.streamDownload")(function* (input: {
        readonly url: string;
        readonly destinationPath: string;
        readonly expectedSha256: string | null;
        readonly expectedBytes: number;
        readonly apiKey: string;
        readonly onProgress?: CivitaiModelInstallProgressReporter;
      }) {
        let request = HttpClientRequest.get(input.url);
        if (input.apiKey) request = HttpClientRequest.bearerToken(input.apiKey)(request);
        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "CivitAI model download request failed.",
                cause,
              }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new CivitaiModelLibraryError({
            message:
              response.status === 401 || response.status === 403
                ? "CivitAI rejected the download. Configure an API key with access to this model."
                : `CivitAI download failed with HTTP ${response.status}.`,
          });
        }

        const contentLength = Number.parseInt(response.headers["content-length"] ?? "", 10);
        const totalBytes =
          input.expectedBytes > 0
            ? input.expectedBytes
            : Number.isFinite(contentLength) && contentLength > 0
              ? contentLength
              : 0;
        const sha256 = createHash("sha256");
        let bytes = 0;
        let lastReportedBytes = -1;
        let lastReportedPercent = -1;
        const reportProgress = (
          status: CivitaiModelInstallProgressStatus,
          force = false,
        ): Effect.Effect<void> => {
          if (!input.onProgress) return Effect.void;
          const percent = totalBytes > 0 ? Math.floor((bytes / totalBytes) * 100) : -1;
          if (
            !force &&
            bytes - lastReportedBytes < 4 * 1024 * 1024 &&
            percent === lastReportedPercent
          ) {
            return Effect.void;
          }
          lastReportedBytes = bytes;
          lastReportedPercent = percent;
          return input.onProgress({
            status,
            bytesDownloaded: bytes,
            totalBytes,
          });
        };
        yield* reportProgress("downloading", true);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(input.destinationPath, { flag: "wx", mode: 0o600 }).pipe(
              Effect.mapError(
                (cause) =>
                  new CivitaiModelLibraryError({
                    message: "Could not create the temporary CivitAI model file.",
                    cause,
                  }),
              ),
            );
            yield* response.stream.pipe(
              Stream.runForEach((chunk) => {
                bytes += chunk.length;
                sha256.update(chunk);
                return file.writeAll(chunk).pipe(Effect.andThen(reportProgress("downloading")));
              }),
              Effect.mapError(
                (cause) =>
                  new CivitaiModelLibraryError({
                    message: "The CivitAI model download stream was interrupted.",
                    cause,
                  }),
              ),
            );
            yield* file.sync.pipe(
              Effect.mapError(
                (cause) =>
                  new CivitaiModelLibraryError({
                    message: "Could not flush the downloaded model to disk.",
                    cause,
                  }),
              ),
            );
          }),
        );

        yield* reportProgress("verifying", true);
        const downloadedSha256 = sha256.digest("hex").toLowerCase();
        if (input.expectedSha256 && downloadedSha256 !== input.expectedSha256) {
          return yield* new CivitaiModelLibraryError({
            message:
              "Downloaded model SHA-256 does not match CivitAI metadata. The temporary file was not installed.",
          });
        }
        if (input.expectedBytes > 0) {
          const tolerance = Math.max(1_048_576, Math.round(input.expectedBytes * 0.005));
          if (Math.abs(bytes - input.expectedBytes) > tolerance) {
            return yield* new CivitaiModelLibraryError({
              message: `Downloaded model size mismatch: expected about ${formatBytes(input.expectedBytes)}, received ${formatBytes(bytes)}.`,
            });
          }
        }
        return { bytes, sha256: downloadedSha256 };
      });

      const install = Effect.fn("CivitaiModelLibrary.install")(function* (
        modelId: number,
        versionId: number,
        onProgress?: CivitaiModelInstallProgressReporter,
      ) {
        const version = yield* fetchVersion(versionId);
        if (version.modelId !== modelId) {
          return yield* new CivitaiModelLibraryError({
            message: "The selected CivitAI version does not belong to the requested model.",
          });
        }
        const primaryFile = selectPrimaryCivitaiFile(version.files);
        if (!primaryFile) {
          return yield* new CivitaiModelLibraryError({
            message: "This CivitAI version does not expose an installable model file.",
          });
        }
        if (isCivitaiFileBlockedByScan(primaryFile)) {
          return yield* new CivitaiModelLibraryError({
            message:
              "CivitAI marked this file with a failed or dangerous security scan, so ShiryuGen will not install it.",
          });
        }
        const installTarget = resolveCivitaiInstallTarget(
          version.model.type,
          version.baseModel ?? null,
        );
        if (!installTarget) {
          return yield* new CivitaiModelLibraryError({
            message: `ShiryuGen does not yet know which ComfyUI model folder should receive CivitAI type '${version.model.type}'.`,
          });
        }

        const root = yield* resolveRoot();
        const modelsRoot = path.resolve(root, "models");
        const targetDirectory = path.resolve(modelsRoot, installTarget);
        const targetPrefix = modelsRoot.endsWith(path.sep)
          ? modelsRoot
          : `${modelsRoot}${path.sep}`;
        if (!targetDirectory.startsWith(targetPrefix)) {
          return yield* new CivitaiModelLibraryError({
            message: "Invalid ComfyUI model install target.",
          });
        }
        yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: `Could not create ComfyUI model directory '${targetDirectory}'.`,
                cause,
              }),
          ),
        );

        const fallbackFileName = `civitai-${modelId}-${versionId}.safetensors`;
        const fileName = sanitizeModelFileName(primaryFile.name, fallbackFileName);
        const destinationPath = path.join(targetDirectory, fileName);
        const downloadId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiModelLibraryError({
                message: "Could not allocate a temporary CivitAI download path.",
                cause,
              }),
          ),
        );
        const tempPath = path.join(targetDirectory, `.${fileName}.${downloadId}.part`);
        const expectedSha256 = normalizeSha256(primaryFile.hashes?.SHA256);
        const expectedBytes = Math.max(0, Math.round((primaryFile.sizeKB ?? 0) * 1024));
        const downloadUrl = primaryFile.downloadUrl ?? version.downloadUrl;
        if (!downloadUrl) {
          return yield* new CivitaiModelLibraryError({
            message: "CivitAI did not provide a download URL for the selected model version.",
          });
        }

        const initialManifest = yield* readManifest(root);
        const initialPrevious =
          initialManifest.items.find((item) => item.modelId === modelId) ?? null;
        if (
          initialPrevious?.versionId === versionId &&
          (yield* fs.exists(destinationPath).pipe(Effect.orElseSucceed(() => false)))
        ) {
          return {
            installed: initialPrevious,
            replacedVersionId: null,
          } satisfies ShiryuGenCivitaiInstallResult;
        }

        const apiKey = yield* readApiKey();
        const downloadAndInstall = Effect.gen(function* () {
          const download = yield* streamDownload({
            url: downloadUrl,
            destinationPath: tempPath,
            expectedSha256,
            expectedBytes,
            apiKey,
            ...(onProgress ? { onProgress } : {}),
          });
          if (onProgress) {
            yield* onProgress({
              status: "installing",
              bytesDownloaded: download.bytes,
              totalBytes: expectedBytes > 0 ? expectedBytes : download.bytes,
            });
          }
          yield* fs.rename(tempPath, destinationPath).pipe(
            Effect.mapError(
              (cause) =>
                new CivitaiModelLibraryError({
                  message: "Could not move the verified model into the ComfyUI library.",
                  cause,
                }),
            ),
          );
          return download;
        }).pipe(
          Effect.catch((error) =>
            fs.remove(tempPath).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const download = yield* downloadAndInstall;

        const relativePath = path.relative(root, destinationPath);
        const installed: ShiryuGenInstalledModel = {
          modelId,
          versionId,
          modelName: version.model.name,
          versionName: version.name,
          type: version.model.type,
          baseModel: version.baseModel ?? null,
          fileName,
          relativePath,
          installTarget,
          sha256: expectedSha256 ?? download.sha256,
          fileSizeBytes: download.bytes,
          installedAt: DateTime.formatIso(yield* DateTime.now),
        };

        const previous = yield* mutateManifest(root, (manifest) => {
          const currentPrevious = manifest.items.find((item) => item.modelId === modelId) ?? null;
          const nextItems = manifest.items.filter((item) => item.modelId !== modelId);
          return Effect.succeed([
            { version: 1 as const, items: [...nextItems, installed] },
            currentPrevious,
          ] as const);
        });

        if (previous) {
          const previousPath = resolveInstalledAbsolutePath(root, previous);
          if (previousPath && previousPath !== destinationPath) {
            yield* fs.remove(previousPath).pipe(Effect.catch(() => Effect.void));
          }
        }

        return {
          installed,
          replacedVersionId: previous?.versionId ?? null,
        } satisfies ShiryuGenCivitaiInstallResult;
      });

      const uninstall = Effect.fn("CivitaiModelLibrary.uninstall")(function* (modelId: number) {
        const root = yield* resolveRoot();
        const installed = yield* mutateManifest(root, (manifest) => {
          const current = manifest.items.find((item) => item.modelId === modelId) ?? null;
          return Effect.succeed([
            {
              version: 1 as const,
              items: current
                ? manifest.items.filter((item) => item.modelId !== modelId)
                : [...manifest.items],
            },
            current,
          ] as const);
        });
        if (!installed) return { removed: false } satisfies ShiryuGenCivitaiUninstallResult;

        const absolutePath = resolveInstalledAbsolutePath(root, installed);
        if (absolutePath) {
          yield* fs.remove(absolutePath).pipe(Effect.catch(() => Effect.void));
        }
        return { removed: true } satisfies ShiryuGenCivitaiUninstallResult;
      });

      return CivitaiModelLibrary.of({ listInstalled, install, uninstall });
    }),
  );
}
