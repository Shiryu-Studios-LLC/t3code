import {
  DEFAULT_SERVER_SETTINGS,
  OllamaSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";

const decodeOllama = Schema.decodeSync(OllamaSettings);

describe("Ollama built-in provider", () => {
  it("registers Ollama as a first-party built-in driver", () => {
    const registered = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    expect(registered.has(ProviderDriverKind.make("ollama"))).toBe(true);
  });

  it("hydrates a default local Ollama instance with no API-key configuration", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const ollama = instances[ProviderInstanceId.make("ollama")];

    expect(ollama?.driver).toBe(ProviderDriverKind.make("ollama"));
    expect(ollama?.enabled).not.toBe(false);
    expect(ollama?.config).toEqual(decodeOllama({}));
    expect(decodeOllama(ollama?.config ?? {}).endpoint).toBe("http://127.0.0.1:11434");
    expect("apiKey" in (ollama?.config as Record<string, unknown>)).toBe(false);
  });

  it("preserves an explicit Ollama endpoint and model configuration during hydration", () => {
    const instanceId = ProviderInstanceId.make("ollama");
    const explicit = {
      driver: ProviderDriverKind.make("ollama"),
      enabled: true,
      config: decodeOllama({
        endpoint: "http://192.168.1.22:11434",
        customModels: ["qwen3:8b"],
      }),
    };
    const instances = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: explicit },
    });

    expect(instances[instanceId]).toEqual(explicit);
  });
});
