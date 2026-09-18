import type { ShiryuGenComfyUiRuntimeState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerSettingsService } from "../serverSettings.ts";

const DEFAULT_COMFY_UI_ENDPOINT = "http://127.0.0.1:8188";
const STARTUP_TIMEOUT_SECONDS = 60;

export interface ComfyUiRuntimeSnapshot {
  readonly state: ShiryuGenComfyUiRuntimeState;
  readonly managedByShiryuGen: boolean;
  readonly error: string | null;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function resolveLocalEndpoint(
  endpoint: string,
): { readonly host: string; readonly port: number } | null {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") return null;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return {
      host: hostname === "localhost" ? "127.0.0.1" : hostname,
      port,
    };
  } catch {
    return null;
  }
}

export class ComfyUiRuntime extends Context.Service<
  ComfyUiRuntime,
  {
    readonly snapshot: Effect.Effect<ComfyUiRuntimeSnapshot>;
    readonly ensureStarted: Effect.Effect<void>;
  }
>()("t3/shiryuGen/ComfyUiRuntime") {
  static readonly layer = Layer.effect(
    ComfyUiRuntime,
    Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const startLock = yield* Semaphore.make(1);
      const runtimeScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const snapshotRef = yield* Ref.make<ComfyUiRuntimeSnapshot>({
        state: "offline",
        managedByShiryuGen: false,
        error: null,
      });
      const childRef = yield* Ref.make<ChildProcessSpawner.ChildProcessHandle | null>(null);

      const setSnapshot = (snapshot: ComfyUiRuntimeSnapshot) => Ref.set(snapshotRef, snapshot);

      const probeEndpoint = (endpoint: string) =>
        httpClient.execute(HttpClientRequest.get(`${endpoint}/system_stats`)).pipe(
          Effect.as(true),
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => false),
        );

      const pickPython = Effect.fn("ComfyUiRuntime.pickPython")(function* (root: string) {
        const candidates = [
          path.join(root, ".venv", "bin", "python"),
          path.join(root, ".venv", "bin", "python3"),
          path.join(root, "venv", "bin", "python"),
          path.join(root, "venv", "bin", "python3"),
        ];
        for (const candidate of candidates) {
          if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
        }
        return "python3";
      });

      const monitorChild = (child: ChildProcessSpawner.ChildProcessHandle, endpoint: string) =>
        child.exitCode.pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.gen(function* () {
                const current = yield* Ref.get(childRef);
                if (current !== child) return;
                yield* Ref.set(childRef, null);
                yield* setSnapshot({
                  state: "failed",
                  managedByShiryuGen: false,
                  error: `Headless ComfyUI process monitoring failed: ${String(cause)}`,
                });
              }),
            onSuccess: (code) =>
              Effect.gen(function* () {
                const current = yield* Ref.get(childRef);
                if (current !== child) return;
                yield* Ref.set(childRef, null);
                const healthy = yield* probeEndpoint(endpoint);
                yield* setSnapshot({
                  state: healthy ? "ready" : code === 0 ? "offline" : "failed",
                  managedByShiryuGen: false,
                  error:
                    healthy || code === 0
                      ? null
                      : `Headless ComfyUI stopped with exit code ${Number(code)}.`,
                });
              }),
          }),
        );

      const startUnlocked = Effect.fn("ComfyUiRuntime.startUnlocked")(function* () {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.catch((cause) =>
            setSnapshot({
              state: "failed",
              managedByShiryuGen: false,
              error: `Could not read ShiryuGen image engine settings: ${cause.message}`,
            }).pipe(Effect.as(null)),
          ),
        );
        if (settings === null) return;

        const imageSettings = settings.imageGeneration;
        const endpoint = normalizeEndpoint(
          imageSettings.comfyUiEndpoint || DEFAULT_COMFY_UI_ENDPOINT,
        );
        const shouldAutoStart =
          imageSettings.autoStartComfyUi &&
          (imageSettings.engine === "auto" || imageSettings.engine === "comfyui");

        if (!shouldAutoStart) {
          yield* setSnapshot({ state: "offline", managedByShiryuGen: false, error: null });
          return;
        }

        if (yield* probeEndpoint(endpoint)) {
          yield* setSnapshot({
            state: "ready",
            managedByShiryuGen: (yield* Ref.get(childRef)) !== null,
            error: null,
          });
          return;
        }

        const existingChild = yield* Ref.get(childRef);
        if (existingChild !== null) {
          const current = yield* Ref.get(snapshotRef);
          yield* setSnapshot({
            state: current.state === "starting" ? "starting" : "failed",
            managedByShiryuGen: true,
            error:
              current.state === "starting"
                ? null
                : (current.error ?? "ComfyUI is running but its API is not reachable."),
          });
          return;
        }

        const localEndpoint = resolveLocalEndpoint(endpoint);
        if (localEndpoint === null) {
          yield* setSnapshot({
            state: "offline",
            managedByShiryuGen: false,
            error: "Automatic startup is only available for a local ComfyUI endpoint.",
          });
          return;
        }

        const root = imageSettings.comfyUiRootDirectory.trim();
        const mainPath = path.join(root, "main.py");
        if (
          !root ||
          !path.isAbsolute(root) ||
          !(yield* fs.exists(mainPath).pipe(Effect.orElseSucceed(() => false)))
        ) {
          yield* setSnapshot({
            state: "failed",
            managedByShiryuGen: false,
            error: `ComfyUI main.py was not found in '${root || "(unset)"}'.`,
          });
          return;
        }

        const python = yield* pickPython(root);
        const args = [
          mainPath,
          "--listen",
          localEndpoint.host,
          "--port",
          String(localEndpoint.port),
          "--disable-auto-launch",
        ];

        yield* Effect.logInfo("Starting Headless ComfyUI for ShiryuGen", {
          command: python,
          args,
          cwd: root,
          endpoint,
        });
        yield* setSnapshot({ state: "starting", managedByShiryuGen: true, error: null });

        const child = yield* spawner
          .spawn(
            ChildProcess.make(python, args, {
              cwd: root,
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.catch((cause) =>
              setSnapshot({
                state: "failed",
                managedByShiryuGen: false,
                error: `Could not launch ComfyUI: ${cause.message}`,
              }).pipe(Effect.as(null)),
            ),
          );
        if (child === null) return;

        yield* Ref.set(childRef, child);
        yield* monitorChild(child, endpoint).pipe(Effect.forkIn(runtimeScope));

        for (let attempt = 0; attempt < STARTUP_TIMEOUT_SECONDS; attempt += 1) {
          if (yield* probeEndpoint(endpoint)) {
            yield* setSnapshot({ state: "ready", managedByShiryuGen: true, error: null });
            yield* Effect.logInfo("Headless ComfyUI is ready for ShiryuGen", { endpoint });
            return;
          }
          if ((yield* Ref.get(childRef)) !== child) return;
          yield* Effect.sleep("1 second");
        }

        yield* setSnapshot({
          state: "failed",
          managedByShiryuGen: true,
          error: `Headless ComfyUI did not become ready within ${STARTUP_TIMEOUT_SECONDS} seconds.`,
        });
        yield* child
          .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
          .pipe(Effect.ignore);
      });

      const ensureStarted = startLock.withPermit(startUnlocked());

      yield* Effect.addFinalizer(() =>
        Ref.get(childRef).pipe(
          Effect.flatMap((child) =>
            child === null
              ? Effect.void
              : Effect.logInfo("Stopping Headless ComfyUI started by ShiryuGen").pipe(
                  Effect.andThen(
                    child
                      .kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
                      .pipe(Effect.ignore),
                  ),
                ),
          ),
        ),
      );

      yield* settingsService.ready.pipe(
        Effect.flatMap(() => ensureStarted),
        Effect.catch((cause) =>
          setSnapshot({
            state: "failed",
            managedByShiryuGen: false,
            error: `Could not initialize Headless ComfyUI: ${cause.message}`,
          }),
        ),
        Effect.forkIn(runtimeScope),
      );

      return ComfyUiRuntime.of({
        snapshot: Ref.get(snapshotRef),
        ensureStarted,
      });
    }),
  );
}
