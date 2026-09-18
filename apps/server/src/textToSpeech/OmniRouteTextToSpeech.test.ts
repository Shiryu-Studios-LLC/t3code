import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  resolveOmniRouteTextToSpeechTarget,
  synthesizeOmniRouteSpeech,
} from "./OmniRouteTextToSpeech.ts";

const instanceId = ProviderInstanceId.make("omniroute");
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const providerSettings = {
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make("omniroute"),
      enabled: true,
      environment: [
        {
          name: "OMNIROUTE_API_KEY" as const,
          value: "test-endpoint-key",
          sensitive: true,
        },
      ],
      config: {
        endpoint: "http://127.0.0.1:20128/",
        freeOnly: true,
        ttsModel: "gtts/default",
      },
    },
  },
} as const;

describe("OmniRoute text to speech", () => {
  it.effect("resolves the configured shared speech endpoint and endpoint key", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
      );
      const target = yield* resolveOmniRouteTextToSpeechTarget(settings);

      expect(target).toEqual({
        endpoint: "http://127.0.0.1:20128/v1/audio/speech",
        apiKey: "test-endpoint-key",
        model: "gtts/default",
      });
    }).pipe(Effect.provide(ServerSettingsService.layerTest(providerSettings))),
  );

  it.effect("sends OpenAI-compatible speech requests through OmniRoute", () => {
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | undefined;
      readonly body: unknown;
    }> = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const bodyText =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            body: decodeUnknownJson(bodyText),
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "audio/mpeg" },
            }),
          );
        }),
      ),
    );

    return synthesizeOmniRouteSpeech({ text: "Hello", voice: "en", rate: 1.25 }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect([...result.bytes]).toEqual([1, 2, 3]);
          expect(result.mimeType).toBe("audio/mpeg");
          expect(requests).toEqual([
            {
              url: "http://127.0.0.1:20128/v1/audio/speech",
              authorization: "Bearer test-endpoint-key",
              body: {
                model: "gtts/default",
                voice: "en",
                input: "Hello",
                response_format: "mp3",
                speed: 1.25,
              },
            },
          ]);
        }),
      ),
      Effect.provide(Layer.merge(httpLayer, ServerSettingsService.layerTest(providerSettings))),
    );
  });
});
