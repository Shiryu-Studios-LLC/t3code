import type { ShiryuGenCivitaiInstallResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import {
  makeCivitaiInstallManager,
  type CivitaiInstallManagerDependencies,
} from "./CivitaiInstallManager.ts";
import { CivitaiModelLibraryError } from "./CivitaiModelLibrary.ts";

function installResult(modelId: number, versionId: number): ShiryuGenCivitaiInstallResult {
  return {
    installed: {
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
    },
    replacedVersionId: null,
  };
}

describe("CivitaiInstallManager", () => {
  it.effect(
    "runs only the configured number of installs and starts queued work as slots open",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const concurrency = yield* Ref.make(3);
          const active = yield* Ref.make(0);
          const peakActive = yield* Ref.make(0);
          const started = new Map<number, Deferred.Deferred<void>>();
          const release = new Map<number, Deferred.Deferred<void>>();

          for (const modelId of [1, 2, 3, 4, 5]) {
            started.set(modelId, yield* Deferred.make<void>());
            release.set(modelId, yield* Deferred.make<void>());
          }

          const install: CivitaiInstallManagerDependencies["install"] = (
            modelId,
            versionId,
            onProgress,
          ) =>
            Effect.gen(function* () {
              const currentActive = yield* Ref.modify(
                active,
                (value) => [value + 1, value + 1] as const,
              );
              yield* Ref.update(peakActive, (value) => Math.max(value, currentActive));
              if (onProgress) {
                yield* onProgress({
                  status: "downloading",
                  bytesDownloaded: 38,
                  totalBytes: 100,
                });
              }
              yield* Deferred.succeed(started.get(modelId)!, undefined);
              yield* Deferred.await(release.get(modelId)!);
              yield* Ref.update(active, (value) => value - 1);
              return installResult(modelId, versionId);
            });

          const manager = yield* makeCivitaiInstallManager({
            install,
            readMaxConcurrency: () => Ref.get(concurrency),
          });

          for (const modelId of [1, 2, 3, 4, 5]) {
            yield* manager.queue(modelId, modelId);
          }
          const finalCompletionFiber = yield* manager.installAndWait(5, 5).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.all(
            [1, 2, 3].map((modelId) => Deferred.await(started.get(modelId)!)),
            {
              concurrency: "unbounded",
            },
          );

          const initial = yield* manager.list();
          expect(initial.activeCount).toBe(3);
          expect(initial.queuedCount).toBe(2);
          expect(initial.maxConcurrency).toBe(3);
          expect(initial.tasks.find((task) => task.modelId === 1)?.progress).toBe(38);
          expect(initial.tasks.find((task) => task.modelId === 4)?.status).toBe("queued");
          expect(yield* Ref.get(peakActive)).toBe(3);

          yield* Deferred.succeed(release.get(1)!, undefined);
          yield* Deferred.await(started.get(4)!);
          const afterSlotOpened = yield* manager.list();
          expect(afterSlotOpened.activeCount).toBe(3);
          expect(afterSlotOpened.queuedCount).toBe(1);
          expect(afterSlotOpened.tasks.find((task) => task.modelId === 4)?.status).toBe(
            "downloading",
          );
          expect(yield* Ref.get(peakActive)).toBe(3);

          for (const modelId of [2, 3, 4, 5]) {
            yield* Deferred.succeed(release.get(modelId)!, undefined);
          }
          yield* Fiber.join(finalCompletionFiber);

          const completed = yield* manager.list();
          expect(completed.activeCount).toBe(0);
          expect(completed.queuedCount).toBe(0);
          expect(completed.tasks.filter((task) => task.status === "completed")).toHaveLength(5);
        }),
      ),
  );

  it.effect("isolates failures and continues the queued installs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const modelTwoStarted = yield* Deferred.make<void>();
        const releaseModelTwo = yield* Deferred.make<void>();

        const install: CivitaiInstallManagerDependencies["install"] = (
          modelId,
          versionId,
          onProgress,
        ) =>
          Effect.gen(function* () {
            if (onProgress) {
              yield* onProgress({
                status: "downloading",
                bytesDownloaded: 1,
                totalBytes: 10,
              });
            }
            if (modelId === 1) {
              return yield* new CivitaiModelLibraryError({ message: "download failed" });
            }
            yield* Deferred.succeed(modelTwoStarted, undefined);
            yield* Deferred.await(releaseModelTwo);
            return installResult(modelId, versionId);
          });

        const manager = yield* makeCivitaiInstallManager({
          install,
          readMaxConcurrency: () => Effect.succeed(1),
        });

        yield* manager.queue(1, 1);
        yield* manager.queue(2, 2);
        yield* Deferred.await(modelTwoStarted);

        const whileSecondRuns = yield* manager.list();
        expect(whileSecondRuns.tasks.find((task) => task.modelId === 1)?.status).toBe("failed");
        expect(whileSecondRuns.tasks.find((task) => task.modelId === 1)?.error).toBe(
          "download failed",
        );
        expect(whileSecondRuns.tasks.find((task) => task.modelId === 2)?.status).toBe(
          "downloading",
        );
        expect(whileSecondRuns.activeCount).toBe(1);
        expect(whileSecondRuns.queuedCount).toBe(0);

        yield* Deferred.succeed(releaseModelTwo, undefined);
      }),
    ),
  );

  it.effect(
    "deduplicates repeated install requests for the same model while a task is active",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const installCalls = yield* Ref.make(0);

          const install: CivitaiInstallManagerDependencies["install"] = (modelId, versionId) =>
            Effect.gen(function* () {
              yield* Ref.update(installCalls, (value) => value + 1);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return installResult(modelId, versionId);
            });

          const manager = yield* makeCivitaiInstallManager({
            install,
            readMaxConcurrency: () => Effect.succeed(3),
          });

          const first = yield* manager.queue(7, 70);
          const second = yield* manager.queue(7, 70);
          yield* Deferred.await(started);

          expect(second.id).toBe(first.id);
          expect(yield* Ref.get(installCalls)).toBe(1);
          expect((yield* manager.list()).tasks.filter((task) => task.modelId === 7)).toHaveLength(
            1,
          );

          yield* Deferred.succeed(release, undefined);
        }),
      ),
  );
});
