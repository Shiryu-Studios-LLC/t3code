import { OmniRouteSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmniRouteTextGeneration } from "../../textGeneration/OmniRouteTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmniRouteAdapter } from "../Layers/OmniRouteAdapter.ts";
import {
  buildInitialOmniRouteProviderSnapshot,
  checkOmniRouteProviderStatus,
} from "../Layers/OmniRouteProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOmniRouteSettings = Schema.decodeSync(OmniRouteSettings);
const DRIVER_KIND = ProviderDriverKind.make("omniroute");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OmniRouteDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | HttpClient.HttpClient
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

export const OmniRouteDriver: ProviderDriver<OmniRouteSettings, OmniRouteDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OmniRoute",
    supportsMultipleInstances: true,
  },
  configSchema: OmniRouteSettings,
  defaultConfig: (): OmniRouteSettings => decodeOmniRouteSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
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
      const effectiveConfig = { ...config, enabled } satisfies OmniRouteSettings;
      const adapter = yield* makeOmniRouteAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
      });
      const textGeneration = yield* makeOmniRouteTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkOmniRouteProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.map(stampIdentity),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OmniRouteSettings>
      >({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmniRouteProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OmniRoute snapshot: ${cause.message ?? String(cause)}`,
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
