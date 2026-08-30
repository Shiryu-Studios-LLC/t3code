import {
  type GeminiSettings,
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

export const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  showInteractionModeToggle: true,
} as const;

export const DEFAULT_GEMINI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "thinking",
      label: "Thinking",
      options: [
        { value: "auto", label: "Auto", isDefault: true },
        { value: "low", label: "Low (1k)" },
        { value: "medium", label: "Medium (8k)" },
        { value: "high", label: "High (24k)" },
        { value: "off", label: "Off" },
      ],
    }),
  ],
});

export const GEMINI_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-2.0-flash-thinking-exp",
    name: "Gemini 2.0 Flash Thinking",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash (Preview)",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Preview)",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite (Preview)",
    isCustom: false,
    capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
  },
];

const GEMINI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  flash: "gemini-2.5-flash",
  "2.5-flash": "gemini-2.5-flash",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-2.5-flash-thinking": "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
  "2.5-pro": "gemini-2.5-pro",
  "gemini-pro": "gemini-2.5-pro",
  "flash-lite": "gemini-2.5-flash-lite",
  "2.5-flash-lite": "gemini-2.5-flash-lite",
  "2.0-flash": "gemini-2.0-flash",
  "1.5-pro": "gemini-1.5-pro",
  "1.5-flash": "gemini-1.5-flash",
  "3.6-flash": "gemini-3.6-flash",
  "3.5-flash": "gemini-3.5-flash",
  "3.1-pro": "gemini-3.1-pro-preview",
};

export function resolveGeminiModel(model: string): string {
  const trimmed = model.trim();
  return GEMINI_MODEL_ALIASES[trimmed] ?? trimmed;
}

export function resolveGeminiApiEndpoint(settings: GeminiSettings): string {
  const configured = settings.apiEndpoint?.trim();
  if (!configured) return "https://generativelanguage.googleapis.com/v1beta";
  const endpoint = configured.replace(/\/+$/, "");
  try {
    const url = new URL(endpoint);
    return url.pathname === "/" ? `${endpoint}/v1beta` : endpoint;
  } catch {
    return endpoint;
  }
}

export function resolveGeminiApiKey(
  settings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const directKey = settings.apiKey?.trim();
  if (directKey && directKey.length > 0) {
    return directKey;
  }
  const envKey = environment.GEMINI_API_KEY?.trim() ?? environment.GOOGLE_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : undefined;
}

export function buildInitialGeminiProviderSnapshot(
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      GEMINI_MODEL_CATALOG,
      geminiSettings.customModels,
      DEFAULT_GEMINI_MODEL_CAPABILITIES,
    );

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Gemini provider status...",
      },
    });
  });
}

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = providerModelsFromSettings(
    GEMINI_MODEL_CATALOG,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const apiKey = resolveGeminiApiKey(geminiSettings, environment);
  const hasKey = Boolean(apiKey);

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
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
        ? "Gemini API key is configured and ready."
        : "Set your Google AI Studio API key in Gemini settings or GEMINI_API_KEY environment variable.",
    },
  });
});

export const enrichGeminiSnapshot = (input: {
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
      Effect.logWarning("Gemini version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
