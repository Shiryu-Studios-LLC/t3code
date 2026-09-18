import {
  type ModelCapabilities,
  type OmniRouteSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const OMNIROUTE_PRESENTATION = {
  displayName: "OmniRoute",
  showInteractionModeToggle: true,
} as const;

export const DEFAULT_OMNIROUTE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const OmniRouteModelsResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
      }),
    ),
  ),
});

const OmniRouteRuntimeSettings = Schema.Struct({
  hidePaidModels: Schema.optional(Schema.Boolean),
});

export const OMNIROUTE_FREE_ROUTE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto/coding:free",
    name: "Auto Coding · Free",
    shortName: "Coding · Free",
    subProvider: "OmniRoute",
    isCustom: false,
    isDefault: true,
    capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  },
  {
    slug: "auto/chat:free",
    name: "Auto Chat · Free",
    shortName: "Chat · Free",
    subProvider: "OmniRoute",
    isCustom: false,
    capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  },
  {
    slug: "auto/reasoning:free",
    name: "Auto Reasoning · Free",
    shortName: "Reasoning · Free",
    subProvider: "OmniRoute",
    isCustom: false,
    capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  },
  {
    slug: "auto/vision:free",
    name: "Auto Vision · Free",
    shortName: "Vision · Free",
    subProvider: "OmniRoute",
    isCustom: false,
    capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  },
  {
    slug: "auto/multimodal:free",
    name: "Auto Multimodal · Free",
    shortName: "Multimodal · Free",
    subProvider: "OmniRoute",
    isCustom: false,
    capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  },
];

export function resolveOmniRouteEndpoint(settings: OmniRouteSettings): string {
  const configured = settings.endpoint?.trim() || "http://127.0.0.1:20128";
  return configured.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export function resolveOmniRouteApiKey(
  settings: OmniRouteSettings,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environmentKey = environment.OMNIROUTE_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  const configured = settings.apiKey?.trim();
  return configured || undefined;
}

export function omniRouteOpenAiEndpoint(settings: OmniRouteSettings): string {
  return `${resolveOmniRouteEndpoint(settings)}/v1`;
}

function modelDisplayName(slug: string): string {
  const freeRoute = OMNIROUTE_FREE_ROUTE_MODELS.find((model) => model.slug === slug);
  if (freeRoute) return freeRoute.name;

  const modelSlug = slug.includes("/") ? slug.split("/").at(-1)! : slug;
  return modelSlug
    .split(/[-_:]/u)
    .filter(Boolean)
    .map((part) =>
      part.length <= 4 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

function isExplicitlyFreeModelSlug(slug: string): boolean {
  const normalized = slug.toLowerCase();
  return (
    normalized.endsWith(":free") || normalized.includes("/free/") || normalized.endsWith("/free")
  );
}

function dedupeModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const bySlug = new Map<string, ServerProviderModel>();
  for (const model of models) {
    if (!bySlug.has(model.slug)) bySlug.set(model.slug, model);
  }
  return [...bySlug.values()];
}

export const probeOmniRoute = Effect.fn("probeOmniRoute")(function* (
  settings: OmniRouteSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const client = yield* HttpClient.HttpClient;
  const apiKey = resolveOmniRouteApiKey(settings, environment);
  const upstreamPaidModelsHidden = yield* client
    .execute(HttpClientRequest.get(`${resolveOmniRouteEndpoint(settings)}/api/settings`))
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(OmniRouteRuntimeSettings)(response).pipe(
              Effect.map((runtimeSettings) => runtimeSettings.hidePaidModels === true),
            )
          : Effect.succeed(false),
      ),
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => false),
    );
  let request = HttpClientRequest.get(`${omniRouteOpenAiEndpoint(settings)}/models`);
  if (apiKey) request = request.pipe(HttpClientRequest.bearerToken(apiKey));

  const response = yield* client.execute(request).pipe(Effect.timeout("4 seconds"));
  if (response.status === 401 || response.status === 403) {
    return {
      reachable: true as const,
      authorized: false as const,
      status: response.status,
      models: [] as ReadonlyArray<ServerProviderModel>,
      upstreamPaidModelsHidden,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      reachable: true as const,
      authorized: true as const,
      status: response.status,
      models: [] as ReadonlyArray<ServerProviderModel>,
      upstreamPaidModelsHidden,
    };
  }

  const body = yield* HttpClientResponse.schemaBodyJson(OmniRouteModelsResponse)(response);
  const discovered = (body.data ?? []).map(
    (model): ServerProviderModel => ({
      slug: model.id,
      name: modelDisplayName(model.id),
      subProvider: model.id.includes("/") ? model.id.split("/", 1)[0] : "OmniRoute",
      isCustom: false,
      capabilities: DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
    }),
  );
  const visibleDiscovered = settings.freeOnly
    ? upstreamPaidModelsHidden
      ? discovered
      : discovered.filter((model) => isExplicitlyFreeModelSlug(model.slug))
    : discovered;
  const models = dedupeModels([...OMNIROUTE_FREE_ROUTE_MODELS, ...visibleDiscovered]);

  return {
    reachable: true as const,
    authorized: true as const,
    status: response.status,
    models,
    upstreamPaidModelsHidden,
  };
});

export const buildInitialOmniRouteProviderSnapshot = Effect.fn(
  "buildInitialOmniRouteProviderSnapshot",
)(function* (settings: OmniRouteSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = providerModelsFromSettings(
    OMNIROUTE_FREE_ROUTE_MODELS,
    settings.customModels,
    DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: OMNIROUTE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: settings.enabled
      ? {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `Checking OmniRoute at ${resolveOmniRouteEndpoint(settings)}...`,
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OmniRoute is disabled in ShiryuGen settings.",
        },
  });
});

export const checkOmniRouteProviderStatus = Effect.fn("checkOmniRouteProviderStatus")(function* (
  settings: OmniRouteSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* buildInitialOmniRouteProviderSnapshot(settings);

  const probe = yield* probeOmniRoute(settings, environment).pipe(
    Effect.orElseSucceed(() => ({
      reachable: false as const,
      authorized: false as const,
      status: 0,
      models: [] as ReadonlyArray<ServerProviderModel>,
      upstreamPaidModelsHidden: false,
    })),
  );
  const baseModels = probe.models.length > 0 ? probe.models : OMNIROUTE_FREE_ROUTE_MODELS;
  const models = providerModelsFromSettings(
    baseModels,
    settings.customModels,
    DEFAULT_OMNIROUTE_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: OMNIROUTE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: probe.reachable,
      version: null,
      status: probe.reachable && probe.authorized && probe.status < 400 ? "ready" : "warning",
      auth: {
        status: probe.authorized
          ? "authenticated"
          : probe.reachable
            ? "unauthenticated"
            : "unknown",
      },
      message: !probe.reachable
        ? `OmniRoute is not responding at ${resolveOmniRouteEndpoint(settings)}. Start your Shiryu Studios OmniRoute fork and refresh providers.`
        : !probe.authorized
          ? "OmniRoute is running, but this endpoint requires an endpoint key. Add the key from OmniRoute Dashboard → Endpoints."
          : probe.status >= 400
            ? `OmniRoute responded with HTTP ${probe.status}. Check the OmniRoute dashboard and request logs.`
            : settings.freeOnly
              ? probe.upstreamPaidModelsHidden
                ? `OmniRoute is ready. Its hidePaidModels policy is active, so ShiryuGen can browse the filtered free catalog plus free auto routes.`
                : `OmniRoute is ready. ShiryuGen is restricted to free auto routes and catalog models explicitly marked free.`
              : `OmniRoute is ready with ${models.length} visible routes/models.`,
    },
  });
});
