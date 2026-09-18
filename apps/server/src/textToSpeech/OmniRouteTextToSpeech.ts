import {
  OmniRouteSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import {
  omniRouteOpenAiEndpoint,
  resolveOmniRouteApiKey,
} from "../provider/Layers/OmniRouteProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const OMNIROUTE_DRIVER = ProviderDriverKind.make("omniroute");
const DEFAULT_OMNIROUTE_INSTANCE_ID = ProviderInstanceId.make("omniroute");
const DEFAULT_OMNIROUTE_TTS_MODEL = "qwen3-local/qwen3-tts";
const decodeOmniRouteSettings = Schema.decodeUnknownEffect(OmniRouteSettings);

export class OmniRouteTextToSpeechError extends Schema.TaggedErrorClass<OmniRouteTextToSpeechError>()(
  "OmniRouteTextToSpeechError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function findOmniRouteInstance(settings: ServerSettings) {
  const preferred = settings.providerInstances[DEFAULT_OMNIROUTE_INSTANCE_ID];
  if (preferred?.driver === OMNIROUTE_DRIVER && preferred.enabled !== false) return preferred;

  return Object.values(settings.providerInstances).find(
    (instance) => instance.driver === OMNIROUTE_DRIVER && instance.enabled !== false,
  );
}

export const resolveOmniRouteTextToSpeechTarget = Effect.fn("textToSpeech.omniroute.resolveTarget")(
  function* (settings: ServerSettings) {
    const instance = findOmniRouteInstance(settings);
    if (!instance) {
      return yield* new OmniRouteTextToSpeechError({
        detail: "OmniRoute text-to-speech requires an enabled OmniRoute provider instance.",
      });
    }

    const config = yield* decodeOmniRouteSettings(instance.config ?? {}).pipe(
      Effect.mapError(
        (cause) =>
          new OmniRouteTextToSpeechError({
            detail: "The configured OmniRoute settings are invalid.",
            cause,
          }),
      ),
    );
    const environment = mergeProviderInstanceEnvironment(instance.environment);
    const apiKey = resolveOmniRouteApiKey(config, environment);

    return {
      endpoint: `${omniRouteOpenAiEndpoint(config)}/audio/speech`,
      apiKey,
      model: config.ttsModel.trim() || DEFAULT_OMNIROUTE_TTS_MODEL,
    };
  },
);

export const synthesizeOmniRouteSpeech = Effect.fn("textToSpeech.omniroute.synthesize")(
  function* (input: { readonly text: string; readonly voice: string; readonly rate: number }) {
    const serverSettings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new OmniRouteTextToSpeechError({
            detail: "Could not load OmniRoute text-to-speech settings.",
            cause,
          }),
      ),
    );
    const target = yield* resolveOmniRouteTextToSpeechTarget(settings);

    let request = HttpClientRequest.post(target.endpoint).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: target.model,
        voice: input.voice,
        input: input.text,
        response_format: "mp3",
        speed: input.rate,
      }),
    );
    if (target.apiKey) request = request.pipe(HttpClientRequest.bearerToken(target.apiKey));

    const response = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) => {
        const status =
          HttpClientError.isHttpClientError(cause) && cause.response !== undefined
            ? cause.response.status
            : null;
        const detail =
          status === 401 || status === 403
            ? "OmniRoute rejected the text-to-speech endpoint key. Update the OmniRoute provider key and try again."
            : status === 429
              ? "OmniRoute text-to-speech is currently rate limited."
              : status === null
                ? `Could not reach OmniRoute text-to-speech at ${target.endpoint}.`
                : `OmniRoute text-to-speech request failed with HTTP ${status}.`;
        return new OmniRouteTextToSpeechError({ detail, cause });
      }),
    );

    const audioBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new OmniRouteTextToSpeechError({
            detail: "OmniRoute text-to-speech returned unreadable audio.",
            cause,
          }),
      ),
    );

    return {
      bytes: new Uint8Array(audioBuffer),
      mimeType: response.headers["content-type"]?.split(";", 1)[0] || "audio/mpeg",
    };
  },
);
