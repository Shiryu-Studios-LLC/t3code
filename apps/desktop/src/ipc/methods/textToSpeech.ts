import { DesktopTextToSpeechSynthesizeInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";

export class DesktopTextToSpeechError extends Schema.TaggedErrorClass<DesktopTextToSpeechError>()(
  "DesktopTextToSpeechError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const synthesizeSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SYNTHESIZE_SPEECH_CHANNEL,
  payload: DesktopTextToSpeechSynthesizeInputSchema,
  result: Schema.Uint8Array,
  handler: Effect.fn("desktop.ipc.textToSpeech.synthesize")(function* (input) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return yield* new DesktopTextToSpeechError({
        message: "OpenAI text-to-speech requires OPENAI_API_KEY on the desktop host.",
      });
    }
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(OPENAI_SPEECH_ENDPOINT).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJson({
        model: OPENAI_SPEECH_MODEL,
        voice: input.voice,
        input: input.text,
        response_format: "mp3",
        speed: input.rate,
      }),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) => {
        const status =
          HttpClientError.isHttpClientError(cause) && cause.response !== undefined
            ? cause.response.status
            : null;
        const message =
          status === 401
            ? "OpenAI rejected OPENAI_API_KEY on the desktop host. Replace it with a valid OpenAI API key and restart T3."
            : status === 429
              ? "OpenAI text-to-speech is rate limited or the API project has no available quota."
              : status === null
                ? "OpenAI text-to-speech request failed."
                : `OpenAI text-to-speech request failed with HTTP ${status}.`;
        return new DesktopTextToSpeechError({ message, cause });
      }),
    );

    const audioBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTextToSpeechError({
            message: "OpenAI text-to-speech returned unreadable audio.",
            cause,
          }),
      ),
    );
    return new Uint8Array(audioBuffer);
  }),
});
