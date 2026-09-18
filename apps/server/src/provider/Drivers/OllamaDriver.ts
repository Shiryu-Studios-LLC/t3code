import { OllamaSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOllamaTextGeneration } from "../../textGeneration/OllamaTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOllamaAdapter } from "../Layers/OllamaAdapter.ts";
import {
  buildInitialOllamaProviderSnapshot,
  checkOllamaProviderStatus,
  probeOllama,
} from "../Layers/OllamaProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOllamaSettings = Schema.decodeSync(OllamaSettings);
const DRIVER_KIND = ProviderDriverKind.make("ollama");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type OllamaDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OllamaDriver: ProviderDriver<OllamaSettings, OllamaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Ollama",
    supportsMultipleInstances: true,
  },
  configSchema: OllamaSettings,
  defaultConfig: (): OllamaSettings => decodeOllamaSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const providerScope = yield* Effect.scope;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OllamaSettings;
      const configuredBinary = effectiveConfig.binaryPath?.trim();
      const localUserBinary = processEnv.HOME ? `${processEnv.HOME}/.local/bin/ollama` : undefined;
      const localUserBinaryExists = localUserBinary
        ? yield* fs.exists(localUserBinary).pipe(Effect.orElseSucceed(() => false))
        : false;
      const binaryPath =
        configuredBinary && configuredBinary !== "ollama"
          ? configuredBinary
          : localUserBinary && localUserBinaryExists
            ? localUserBinary
            : "ollama";
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath,
        env: processEnv,
      });
      const adapter = yield* makeOllamaAdapter(effectiveConfig, { instanceId });
      const textGeneration = yield* makeOllamaTextGeneration(effectiveConfig);
      let localServer: ChildProcessSpawner.ChildProcessHandle | null = null;
      const managesDefaultLocalEndpoint =
        /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::11434)?\/?$/iu.test(
          effectiveConfig.endpoint?.trim() || "http://127.0.0.1:11434",
        );
      const ensureLocalServer = Effect.fn("OllamaDriver.ensureLocalServer")(function* () {
        if (!enabled || !managesDefaultLocalEndpoint) return;
        const alreadyReachable = yield* probeOllama(effectiveConfig).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        if (alreadyReachable) return;
        if (localServer) {
          const running = yield* localServer.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (running) return;
          localServer = null;
        }
        const currentLocalUserBinaryExists = localUserBinary
          ? yield* fs.exists(localUserBinary).pipe(Effect.orElseSucceed(() => false))
          : false;
        const resolvedBinary =
          configuredBinary && configuredBinary !== "ollama"
            ? configuredBinary
            : localUserBinary && currentLocalUserBinaryExists
              ? localUserBinary
              : "ollama";
        localServer = yield* spawner
          .spawn(
            ChildProcess.make(resolvedBinary, ["serve"], {
              env: processEnv,
              extendEnv: true,
              stdout: "inherit",
              stderr: "inherit",
              killSignal: "SIGTERM",
              forceKillAfter: "3 seconds",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, providerScope),
            Effect.orElseSucceed(() => null),
          );
        if (!localServer) return;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const ready = yield* probeOllama(effectiveConfig).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.match({ onFailure: () => false, onSuccess: () => true }),
          );
          if (ready) return;
          const running = yield* localServer.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (!running) {
            localServer = null;
            return;
          }
          yield* Effect.sleep("250 millis");
        }
      });
      const checkProvider = ensureLocalServer().pipe(
        Effect.andThen(checkOllamaProviderStatus(effectiveConfig)),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.map(stampIdentity),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OllamaSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOllamaProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Ollama snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
