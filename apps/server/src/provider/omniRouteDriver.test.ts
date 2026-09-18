import {
  DEFAULT_SERVER_SETTINGS,
  OmniRouteSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import {
  OMNIROUTE_FREE_ROUTE_MODELS,
  resolveOmniRouteEndpoint,
} from "./Layers/OmniRouteProvider.ts";

const decodeOmniRoute = Schema.decodeSync(OmniRouteSettings);

describe("OmniRoute built-in provider", () => {
  it("registers OmniRoute as a first-party built-in driver", () => {
    const registered = new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind));
    expect(registered.has(ProviderDriverKind.make("omniroute"))).toBe(true);
  });

  it("hydrates a default localhost instance with free-only routing enabled", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const omniroute = instances[ProviderInstanceId.make("omniroute")];
    const config = decodeOmniRoute(omniroute?.config ?? {});

    expect(omniroute?.driver).toBe(ProviderDriverKind.make("omniroute"));
    expect(omniroute?.enabled).not.toBe(false);
    expect(config.endpoint).toBe("http://127.0.0.1:20128");
    expect(config.freeOnly).toBe(true);
    expect(config.ttsModel).toBe("kokoro-local/kokoro");
  });

  it("normalizes dashboard and OpenAI-compatible base URLs to one dashboard endpoint", () => {
    expect(resolveOmniRouteEndpoint(decodeOmniRoute({ endpoint: "http://127.0.0.1:20128/" }))).toBe(
      "http://127.0.0.1:20128",
    );
    expect(
      resolveOmniRouteEndpoint(decodeOmniRoute({ endpoint: "http://127.0.0.1:20128/v1" })),
    ).toBe("http://127.0.0.1:20128");
  });

  it("ships capability-focused free auto routes", () => {
    const slugs = new Set(OMNIROUTE_FREE_ROUTE_MODELS.map((model) => model.slug));

    expect(slugs).toContain("auto/coding:free");
    expect(slugs).toContain("auto/chat:free");
    expect(slugs).toContain("auto/reasoning:free");
    expect(slugs).toContain("auto/vision:free");
    expect(slugs).toContain("auto/multimodal:free");
    expect([...slugs].every((slug) => slug.endsWith(":free"))).toBe(true);
  });
});
