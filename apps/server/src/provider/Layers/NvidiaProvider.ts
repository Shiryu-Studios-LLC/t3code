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
    slug: "meta/llama-3.3-70b-instruct",
    name: "Meta Llama 3.3 70B Instruct",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-ai/deepseek-r1",
    name: "DeepSeek R1",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "deepseek-ai/deepseek-v3",
    name: "DeepSeek V3",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "Llama 3.1 Nemotron 70B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen 2.5 Coder 32B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "mistralai/mistral-large-2-instruct",
    name: "Mistral Large 2",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "meta/llama-3.1-405b-instruct",
    name: "Meta Llama 3.1 405B Instruct",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "meta/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct",
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
    slug: "qwen/qwen3-next-80b-a3b-instruct",
    name: "Qwen3 Next 80B",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
  {
    slug: "z-ai/glm4.7",
    name: "GLM 4.7",
    isCustom: false,
    capabilities: DEFAULT_NVIDIA_MODEL_CAPABILITIES,
  },
];

const NVIDIA_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "llama-3.3-70b": "meta/llama-3.3-70b-instruct",
  "llama-3.3": "meta/llama-3.3-70b-instruct",
  "llama-70b": "meta/llama-3.3-70b-instruct",
  "llama-3.1-405b": "meta/llama-3.1-405b-instruct",
  "llama-405b": "meta/llama-3.1-405b-instruct",
  nemotron: "nvidia/llama-3.1-nemotron-70b-instruct",
  "nemotron-70b": "nvidia/llama-3.1-nemotron-70b-instruct",
  r1: "deepseek-ai/deepseek-r1",
  "deepseek-r1": "deepseek-ai/deepseek-r1",
  v3: "deepseek-ai/deepseek-v3",
  "deepseek-v3": "deepseek-ai/deepseek-v3",
  qwen: "qwen/qwen2.5-coder-32b-instruct",
  "qwen-coder": "qwen/qwen2.5-coder-32b-instruct",
  mistral: "mistralai/mistral-large-2-instruct",
  "mistral-large": "mistralai/mistral-large-2-instruct",
  "gpt-oss": "openai/gpt-oss-20b",
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

  const apiKey = resolveNvidiaApiKey(nvidiaSettings, environment);
  const hasKey = Boolean(apiKey);

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
