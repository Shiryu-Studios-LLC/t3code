import type {
  ShiryuGenCivitaiInstallResult,
  ShiryuGenCivitaiInstallTask,
  ShiryuGenCivitaiInstallTasksResult,
} from "@t3tools/contracts";
import { DEFAULT_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY } from "@t3tools/contracts";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  CivitaiModelLibrary,
  CivitaiModelLibraryError,
  type CivitaiModelInstallProgress,
} from "./CivitaiModelLibrary.ts";

const MAX_RETAINED_TASKS = 100;
const TERMINAL_TASK_RETENTION = 50;

interface ManagedInstallTask {
  readonly snapshot: ShiryuGenCivitaiInstallTask;
  readonly completion: Deferred.Deferred<ShiryuGenCivitaiInstallResult, CivitaiModelLibraryError>;
}

export interface CivitaiInstallManagerDependencies {
  readonly install: CivitaiModelLibrary["Service"]["install"];
  readonly readMaxConcurrency: () => Effect.Effect<number>;
}

export interface CivitaiInstallManagerShape {
  readonly queue: (
    modelId: number,
    versionId: number,
  ) => Effect.Effect<ShiryuGenCivitaiInstallTask>;
  readonly list: () => Effect.Effect<ShiryuGenCivitaiInstallTasksResult>;
  readonly installAndWait: (
    modelId: number,
    versionId: number,
  ) => Effect.Effect<ShiryuGenCivitaiInstallResult, CivitaiModelLibraryError>;
  readonly hasActiveModel: (modelId: number) => Effect.Effect<boolean>;
}

function isTerminal(status: ShiryuGenCivitaiInstallTask["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isActive(status: ShiryuGenCivitaiInstallTask["status"]): boolean {
  return status === "downloading" || status === "verifying" || status === "installing";
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY;
  return Math.min(6, Math.max(1, Math.round(value)));
}

function progressPercent(bytesDownloaded: number, totalBytes: number): number | null {
  if (totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (bytesDownloaded / totalBytes) * 100));
}

function pruneTasks(tasks: ReadonlyArray<ManagedInstallTask>): ReadonlyArray<ManagedInstallTask> {
  if (tasks.length < MAX_RETAINED_TASKS) return tasks;
  const terminalIdsToKeep = new Set(
    tasks
      .filter((task) => isTerminal(task.snapshot.status))
      .slice(-TERMINAL_TASK_RETENTION)
      .map((task) => task.snapshot.id),
  );
  return tasks.filter(
    (task) => !isTerminal(task.snapshot.status) || terminalIdsToKeep.has(task.snapshot.id),
  );
}

export const makeCivitaiInstallManager = Effect.fn("makeCivitaiInstallManager")(function* (
  dependencies: CivitaiInstallManagerDependencies,
) {
  const tasksRef = yield* Ref.make<ReadonlyArray<ManagedInstallTask>>([]);
  const pumpLock = yield* Semaphore.make(1);
  const workerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const updateTask = (
    taskId: string,
    update: (snapshot: ShiryuGenCivitaiInstallTask) => ShiryuGenCivitaiInstallTask,
  ) =>
    Ref.update(tasksRef, (tasks) =>
      tasks.map((task) =>
        task.snapshot.id === taskId ? { ...task, snapshot: update(task.snapshot) } : task,
      ),
    );

  const reportProgress = (taskId: string, progress: CivitaiModelInstallProgress) =>
    updateTask(taskId, (snapshot) => {
      if (isTerminal(snapshot.status)) return snapshot;
      return {
        ...snapshot,
        status: progress.status,
        bytesDownloaded: progress.bytesDownloaded,
        totalBytes: progress.totalBytes,
        progress: progressPercent(progress.bytesDownloaded, progress.totalBytes),
      };
    });

  const runTask = Effect.fn("CivitaiInstallManager.runTask")(function* (taskId: string) {
    const task = (yield* Ref.get(tasksRef)).find((entry) => entry.snapshot.id === taskId);
    if (!task) return;

    yield* dependencies
      .install(task.snapshot.modelId, task.snapshot.versionId, (progress) =>
        reportProgress(taskId, progress),
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.gen(function* () {
              const finishedAt = DateTime.formatIso(yield* DateTime.now);
              yield* updateTask(taskId, (snapshot) => ({
                ...snapshot,
                status: "failed",
                error: error.message,
                finishedAt,
              }));
              yield* Deferred.fail(task.completion, error);
            }),
          onSuccess: (result) =>
            Effect.gen(function* () {
              const finishedAt = DateTime.formatIso(yield* DateTime.now);
              yield* updateTask(taskId, (snapshot) => ({
                ...snapshot,
                status: "completed",
                bytesDownloaded: result.installed.fileSizeBytes,
                totalBytes:
                  snapshot.totalBytes > 0 ? snapshot.totalBytes : result.installed.fileSizeBytes,
                progress: 100,
                error: null,
                finishedAt,
                installed: result.installed,
                replacedVersionId: result.replacedVersionId,
              }));
              yield* Deferred.succeed(task.completion, result);
            }),
        }),
      );

    yield* pump();
  });

  function pump(): Effect.Effect<void> {
    return pumpLock.withPermit(
      Effect.gen(function* () {
        const maxConcurrency = normalizeConcurrency(yield* dependencies.readMaxConcurrency());
        const tasks = yield* Ref.get(tasksRef);
        const activeCount = tasks.filter((task) => isActive(task.snapshot.status)).length;
        const slots = Math.max(0, maxConcurrency - activeCount);
        if (slots === 0) return;

        const toStart = tasks.filter((task) => task.snapshot.status === "queued").slice(0, slots);
        if (toStart.length === 0) return;

        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const ids = new Set(toStart.map((task) => task.snapshot.id));
        yield* Ref.update(tasksRef, (current) =>
          current.map((task) =>
            ids.has(task.snapshot.id)
              ? {
                  ...task,
                  snapshot: {
                    ...task.snapshot,
                    status: "downloading",
                    startedAt,
                  },
                }
              : task,
          ),
        );

        for (const task of toStart) {
          yield* runTask(task.snapshot.id).pipe(Effect.forkIn(workerScope));
        }
      }),
    );
  }

  const enqueueInternal = Effect.fn("CivitaiInstallManager.enqueueInternal")(function* (
    modelId: number,
    versionId: number,
  ) {
    const completion = yield* Deferred.make<
      ShiryuGenCivitaiInstallResult,
      CivitaiModelLibraryError
    >();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const candidate: ManagedInstallTask = {
      completion,
      snapshot: {
        id: randomUUID(),
        modelId,
        versionId,
        status: "queued",
        bytesDownloaded: 0,
        totalBytes: 0,
        progress: null,
        error: null,
        createdAt,
        startedAt: null,
        finishedAt: null,
        installed: null,
        replacedVersionId: null,
      },
    };

    const managed = yield* Ref.modify(tasksRef, (tasks) => {
      const existing = tasks.find(
        (task) => task.snapshot.modelId === modelId && !isTerminal(task.snapshot.status),
      );
      if (existing) return [existing, tasks] as const;
      return [candidate, [...pruneTasks(tasks), candidate]] as const;
    });
    yield* pump();
    return managed;
  });

  const queue = Effect.fn("CivitaiInstallManager.queue")(function* (
    modelId: number,
    versionId: number,
  ) {
    const managed = yield* enqueueInternal(modelId, versionId);
    return (
      (yield* Ref.get(tasksRef)).find((task) => task.snapshot.id === managed.snapshot.id)
        ?.snapshot ?? managed.snapshot
    );
  });

  const installAndWait = Effect.fn("CivitaiInstallManager.installAndWait")(function* (
    modelId: number,
    versionId: number,
  ) {
    const managed = yield* enqueueInternal(modelId, versionId);
    return yield* Deferred.await(managed.completion);
  });

  const list = Effect.fn("CivitaiInstallManager.list")(function* () {
    yield* pump();
    const tasks = (yield* Ref.get(tasksRef)).map((task) => task.snapshot);
    const maxConcurrency = normalizeConcurrency(yield* dependencies.readMaxConcurrency());
    return {
      tasks,
      activeCount: tasks.filter((task) => isActive(task.status)).length,
      queuedCount: tasks.filter((task) => task.status === "queued").length,
      maxConcurrency,
    } satisfies ShiryuGenCivitaiInstallTasksResult;
  });

  const hasActiveModel = Effect.fn("CivitaiInstallManager.hasActiveModel")(function* (
    modelId: number,
  ) {
    return (yield* Ref.get(tasksRef)).some(
      (task) => task.snapshot.modelId === modelId && !isTerminal(task.snapshot.status),
    );
  });

  return { queue, list, installAndWait, hasActiveModel } satisfies CivitaiInstallManagerShape;
});

export class CivitaiInstallManager extends Context.Service<
  CivitaiInstallManager,
  CivitaiInstallManagerShape
>()("t3/shiryuGen/CivitaiInstallManager") {
  static readonly layer = Layer.effect(
    CivitaiInstallManager,
    Effect.gen(function* () {
      const library = yield* CivitaiModelLibrary;
      const settingsService = yield* ServerSettingsService;
      return yield* makeCivitaiInstallManager({
        install: library.install,
        readMaxConcurrency: () =>
          settingsService.getSettings.pipe(
            Effect.map((settings) => settings.imageGeneration.modelDownloadConcurrency),
            Effect.orElseSucceed(() => DEFAULT_LOCAL_IMAGE_MODEL_DOWNLOAD_CONCURRENCY),
          ),
      });
    }),
  );
}
