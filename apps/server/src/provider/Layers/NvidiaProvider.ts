// @effect-diagnostics globalTimersInEffect:off globalFetchInEffect:off - Provider discovery uses the vendor HTTP boundary with an abort timeout.
import {
  type NvidiaSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { HttpClient } from "effect/unstable/http";
import { causeErrorTag } from "@t3tools/shared/observability";

export const NVIDIA_PRESENTATION = {
  displayName: "NVIDIA",
  showInteractionModeToggle: true,
} as const;

export const DEFAULT_NVIDIA_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "temperature",
      label: "Temperature",
      options: [
        { value: "0.2", label: "Precise (0.2)", isDefault: true },
        { value: "0.6", label: "Balanced (0.6)" },
        { value: "1.0", label: "Creative (1.0)" },
      ],
    }),
  ],
});

export const NVIDIA_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek-ai/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-ai/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "meta/llama-3.2-90b-vision-instruct",
    name: "Meta Llama 3.2 90B Vision",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "meta/llama-3.2-11b-vision-instruct",
    name: "Meta Llama 3.2 11B Vision",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "nvidia/nemotron-3-ultra-550b-a55b",
    name: "Nemotron 3 Ultra",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "nvidia/nemotron-3-nano-30b-a3b",
    name: "Nemotron 3 Nano",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "google/diffusiongemma-26b-a4b-it",
    name: "Diffusion Gemma 26B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
];

const NVIDIA_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "llama-3.2-90b": "meta/llama-3.2-90b-vision-instruct",
  "llama-3.2-11b": "meta/llama-3.2-11b-vision-instruct",
  "llama-90b": "meta/llama-3.2-90b-vision-instruct",
  "llama-11b": "meta/llama-3.2-11b-vision-instruct",
  "llama-3.3-70b": "meta/llama-3.2-90b-vision-instruct",
  "llama-3.3": "meta/llama-3.2-90b-vision-instruct",
  "llama-70b": "meta/llama-3.2-90b-vision-instruct",
  "llama-3.1-405b": "meta/llama-3.2-90b-vision-instruct",
  "llama-405b": "meta/llama-3.2-90b-vision-instruct",
  nemotron: "nvidia/nemotron-3-ultra-550b-a55b",
  "nemotron-ultra": "nvidia/nemotron-3-ultra-550b-a55b",
  "nemotron-super": "nvidia/nemotron-3-super-120b-a12b",
  "nemotron-nano": "nvidia/nemotron-3-nano-30b-a3b",
  "nemotron-70b": "nvidia/nemotron-3-ultra-550b-a55b",
  r1: "deepseek-ai/deepseek-v4-pro-0813",
  "deepseek-r1": "deepseek-ai/deepseek-v4-pro-0813",
  v3: "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-v3": "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-v4": "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-v4-flash": "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-v4-pro": "deepseek-ai/deepseek-v4-pro-0813",
  "gpt-oss": "openai/gpt-oss-120b",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "gpt-oss-20b": "openai/gpt-oss-20b",
};

export function resolveNvidiaModel(model: string): string {
  const trimmed = model.trim();
  return NVIDIA_MODEL_ALIASES[trimmed] ?? trimmed;
}

export function resolveNvidiaApiKey(
  settings: NvidiaSettings,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const directKey = settings.apiKey?.trim();
  if (directKey && directKey.length > 0) {
    return directKey;
  }
  const envKey =
    environment.NVIDIA_API_KEY?.trim() ??
    environment.NVIDIA_NIM_API_KEY?.trim() ??
    environment.NVAPI_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : undefined;
}

function isUsableNvidiaChatModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("embed") ||
    lower.includes("guard") ||
    lower.includes("reward") ||
    lower.includes("detector") ||
    lower.includes("parse") ||
    lower.includes("nvclip") ||
    lower.includes("deplot") ||
    lower.includes("fuyu") ||
    lower.includes("kosmos") ||
    lower.includes("neva")
  ) {
    return false;
  }
  return true;
}

function formatModelDisplayName(modelId: string): string {
  const parts = modelId.split("/");
  const slug = parts.length > 1 ? parts[1]! : parts[0]!;
  return slug
    .split(/[-_]/)
    .map((word) =>
      word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export function fetchNvidiaRemoteModels(
  apiKey: string,
  endpoint: string,
): Effect.Effect<ReadonlyArray<ServerProviderModel>> {
  return Effect.gen(function* () {
    const url = `${endpoint.replace(/\/+$/, "")}/models`;
    const response = yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          if (!res.ok) return [];
          const data = (await res.json()) as { data?: Array<{ id: string }> };
          if (!Array.isArray(data?.data)) return [];
          const remoteModels: ServerProviderModel[] = [];
          for (const item of data.data) {
            if (typeof item?.id === "string" && isUsableNvidiaChatModel(item.id)) {
              remoteModels.push({
                slug: item.id,
                name: formatModelDisplayName(item.id),
                isCustom: false,
                capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
              });
            }
          }
          return remoteModels;
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: () => [] as ServerProviderModel[],
    });
    return response;
  }).pipe(Effect.catchCause(() => Effect.succeed([] as ServerProviderModel[])));
}

export function buildInitialNvidiaProviderSnapshot(
  nvidiaSettings: NvidiaSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      NVIDIA_MODEL_CATALOG,
      nvidiaSettings.customModels,
      DEFAULT_NVIDIA_MODEL_CAPABILITIES,
    );

    if (!nvidiaSettings.enabled) {
      return buildServerProvider({
        presentation: NVIDIA_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "NVIDIA is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: NVIDIA_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking NVIDIA provider status...",
      },
    });
  });
}

export const checkNvidiaProviderStatus = Effect.fn("checkNvidiaProviderStatus")(function* (
  nvidiaSettings: NvidiaSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!nvidiaSettings.enabled) {
    return buildServerProvider({
      presentation: NVIDIA_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        NVIDIA_MODEL_CATALOG,
        nvidiaSettings.customModels,
        DEFAULT_NVIDIA_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "NVIDIA is disabled in T3 Code settings.",
      },
    });
  }

  const apiKey = resolveNvidiaApiKey(nvidiaSettings, environment);
  const hasKey = Boolean(apiKey);
  const endpoint = nvidiaSettings.apiEndpoint?.trim() || "https://integrate.api.nvidia.com/v1";

  let baseCatalog = NVIDIA_MODEL_CATALOG;
  if (hasKey && apiKey) {
    const liveModels = yield* fetchNvidiaRemoteModels(apiKey, endpoint);
    if (liveModels.length > 0) {
      baseCatalog = liveModels;
    }
  }

  const models = providerModelsFromSettings(
    baseCatalog,
    nvidiaSettings.customModels,
    DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: NVIDIA_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: hasKey ? "ready" : "warning",
      auth: {
        status: hasKey ? "authenticated" : "unknown",
        type: "api_key",
      },
      message: hasKey
        ? "NVIDIA NIM API key is configured and ready."
        : "Set your NVIDIA Build / NIM API key in NVIDIA settings or NVIDIA_API_KEY environment variable.",
    },
  });
});

export const enrichNvidiaSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("NVIDIA version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
// @effect-diagnostics globalTimersInEffect:off globalFetchInEffect:off - Provider discovery uses the vendor HTTP boundary with an abort timeout.
