import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  makeSerializedManifestMutator,
  type InstalledModelManifest,
} from "./CivitaiModelLibrary.ts";

function item(modelId: number): InstalledModelManifest["items"][number] {
  return {
    modelId,
    versionId: modelId * 10,
    modelName: `Model ${modelId}`,
    versionName: `Version ${modelId}`,
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

describe("Civitai model manifest mutation", () => {
  it.effect(
    "serializes overlapping read-modify-write mutations so completed installs are not lost",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let manifest: InstalledModelManifest = { version: 1, items: [] };
          const firstMutationRead = yield* Deferred.make<void>();
          const releaseFirstMutation = yield* Deferred.make<void>();
          const secondMutationAttempted = yield* Deferred.make<void>();

          const mutateManifest = yield* makeSerializedManifestMutator({
            read: () =>
              Effect.sync(() => ({
                version: 1 as const,
                items: [...manifest.items],
              })),
            write: (_root, next) =>
              Effect.sync(() => {
                manifest = next;
              }),
          });

          const firstFiber = yield* mutateManifest("root", (current) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(firstMutationRead, undefined);
              yield* Deferred.await(releaseFirstMutation);
              return [
                { version: 1 as const, items: [...current.items, item(1)] },
                undefined,
              ] as const;
            }),
          ).pipe(Effect.forkChild);

          yield* Deferred.await(firstMutationRead);
          const secondFiber = yield* Deferred.succeed(secondMutationAttempted, undefined).pipe(
            Effect.andThen(
              mutateManifest("root", (current) =>
                Effect.succeed([
                  { version: 1 as const, items: [...current.items, item(2)] },
                  undefined,
                ] as const),
              ),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(secondMutationAttempted);
          yield* Effect.yieldNow;

          expect(secondFiber.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseFirstMutation, undefined);
          yield* Fiber.join(firstFiber);
          yield* Fiber.join(secondFiber);

          expect(manifest.items.map((entry) => entry.modelId)).toEqual([1, 2]);
        }),
      ),
  );

  it.effect("uses the same critical section for install/remove-style mutations", () =>
    Effect.gen(function* () {
      let manifest: InstalledModelManifest = { version: 1, items: [item(2)] };
      const mutateManifest = yield* makeSerializedManifestMutator({
        read: () => Effect.succeed({ version: 1 as const, items: [...manifest.items] }),
        write: (_root, next) =>
          Effect.sync(() => {
            manifest = next;
          }),
      });

      yield* mutateManifest("root", (current) =>
        Effect.succeed([
          { version: 1 as const, items: [...current.items, item(1)] },
          undefined,
        ] as const),
      );
      yield* mutateManifest("root", (current) =>
        Effect.succeed([
          {
            version: 1 as const,
            items: current.items.filter((entry) => entry.modelId !== 2),
          },
          undefined,
        ] as const),
      );

      expect(manifest.items.map((entry) => entry.modelId)).toEqual([1]);
    }),
  );
});
