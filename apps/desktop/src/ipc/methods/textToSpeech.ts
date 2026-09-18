import {
  DesktopSystemSpeechInputSchema,
  DesktopTextToSpeechSynthesizeInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const ESPEAK_DEFAULT_RATE = 175;
const KOKORO_DEFAULT_VOICE = "am_michael";
const KOKORO_PACKAGE = "kokoro-onnx==0.6.1";
const KOKORO_GPU_PACKAGE = "onnxruntime-gpu>=1.20,<2";
const KOKORO_WORKER_PORT = 37831;
let activeSystemSpeech: ChildProcessSpawner.ChildProcessHandle | null = null;
let kokoroWorker: ChildProcessSpawner.ChildProcessHandle | null = null;
let kokoroSpeechGeneration = 0;
let activeKokoroSpeech = false;

function concatChunks(arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  let totalLength = 0;
  for (const array of arrays) totalLength += array.byteLength;
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.byteLength;
  }
  return output;
}

const stopActiveSystemSpeech = Effect.fn("desktop.textToSpeech.stopActiveSystemSpeech")(
  function* () {
    const handle = activeSystemSpeech;
    activeSystemSpeech = null;
    if (!handle) return;
    const running = yield* handle.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) return;
    yield* handle
      .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
      .pipe(Effect.catch(() => Effect.void));
  },
);

const speakLinuxSystemSpeech = Effect.fn("desktop.textToSpeech.espeak")(function* (
  text: string,
  rate: number,
) {
  yield* stopActiveSystemSpeech();
  const wordsPerMinute = Math.max(80, Math.min(450, Math.round(ESPEAK_DEFAULT_RATE * rate)));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("espeak-ng", ["-s", String(wordsPerMinute), "--", text], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTextToSpeechError({
            message:
              "Linux system text-to-speech requires espeak-ng on the desktop host. Install espeak-ng and restart T3.",
            cause,
          }),
      ),
    );
  activeSystemSpeech = handle;
  const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
    [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
    { concurrency: "unbounded" },
  );
  const stillActive = activeSystemSpeech === handle;
  if (stillActive) activeSystemSpeech = null;
  if ((exitCode as unknown as number) !== 0 && stillActive) {
    const detail = new TextDecoder().decode(concatChunks(stderrBytes)).trim();
    return yield* new DesktopTextToSpeechError({
      message:
        detail ||
        `espeak-ng exited with code ${String(exitCode)} after producing ${String(concatChunks(stdoutBytes).byteLength)} bytes.`,
    });
  }
});

function resolveKokoroWorkerPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && !resourcesPath.includes("node_modules/electron")) {
    return `${resourcesPath}/kokoro/kokoro_tts.py`;
  }
  return `${process.cwd()}/apps/desktop/prod-resources/kokoro/kokoro_tts.py`;
}

function resolveKokoroCacheDirectory(): string {
  const explicitCacheRoot = process.env.XDG_CACHE_HOME?.trim();
  const homeDirectory = process.env.HOME?.trim();
  const cacheRoot = explicitCacheRoot || (homeDirectory ? `${homeDirectory}/.cache` : "/tmp");
  return `${cacheRoot}/t3-studio/kokoro`;
}

function kokoroWorkerUrl(path: string): string {
  return `http://127.0.0.1:${String(KOKORO_WORKER_PORT)}${path}`;
}

const isKokoroWorkerReady = Effect.fn("desktop.textToSpeech.kokoro.health")(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return yield* httpClient.execute(HttpClientRequest.get(kokoroWorkerUrl("/health"))).pipe(
    Effect.map((response) => response.status >= 200 && response.status < 300),
    Effect.orElseSucceed(() => false),
  );
});

const requestKokoroWorker = Effect.fn("desktop.textToSpeech.kokoro.request")(function* (
  path: string,
  payload: Record<string, unknown>,
) {
  const httpClient = yield* HttpClient.HttpClient;
  yield* HttpClientRequest.post(kokoroWorkerUrl(path)).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new DesktopTextToSpeechError({
          message: `Kokoro local text-to-speech request failed (${path}).`,
          cause,
        }),
    ),
  );
});

const ensureKokoroWorker = Effect.fn("desktop.textToSpeech.kokoro.ensureWorker")(function* () {
  if (yield* isKokoroWorkerReady()) return;

  if (kokoroWorker) {
    const running = yield* kokoroWorker.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) kokoroWorker = null;
  }

  if (!kokoroWorker) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const workerPath = resolveKokoroWorkerPath();
    kokoroWorker = yield* spawner
      .spawn(
        ChildProcess.make(
          "uv",
          [
            "run",
            "--quiet",
            "--python",
            "3.12",
            "--with",
            KOKORO_PACKAGE,
            "--with",
            KOKORO_GPU_PACKAGE,
            workerPath,
            "--cache-dir",
            resolveKokoroCacheDirectory(),
            "--server-port",
            String(KOKORO_WORKER_PORT),
            "--parent-pid",
            String(process.pid),
          ],
          {
            stdout: "inherit",
            stderr: "inherit",
            killSignal: "SIGTERM",
            forceKillAfter: "2 seconds",
          },
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopTextToSpeechError({
              message:
                "Kokoro local text-to-speech requires the uv runtime on the desktop host. Install uv and restart T3.",
              cause,
            }),
        ),
      );
    yield* kokoroWorker.unref.pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new DesktopTextToSpeechError({
            message: "Failed to detach the Kokoro local speech worker.",
            cause,
          }),
      ),
    );
  }

  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (yield* isKokoroWorkerReady()) return;
    const running = yield* kokoroWorker.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) {
      kokoroWorker = null;
      break;
    }
    yield* Effect.sleep("250 millis");
  }

  return yield* new DesktopTextToSpeechError({
    message: "Kokoro local text-to-speech did not become ready.",
  });
});

const speakLinuxKokoroSpeech = Effect.fn("desktop.textToSpeech.kokoro")(function* (
  text: string,
  rate: number,
  voice: string,
) {
  yield* stopActiveSystemSpeech();
  const generation = ++kokoroSpeechGeneration;
  activeKokoroSpeech = true;
  try {
    yield* ensureKokoroWorker();
    if (generation !== kokoroSpeechGeneration) return;
    yield* requestKokoroWorker("/speak", {
      text,
      voice: voice || KOKORO_DEFAULT_VOICE,
      rate,
    });
  } finally {
    if (generation === kokoroSpeechGeneration) activeKokoroSpeech = false;
  }
});

export class DesktopTextToSpeechError extends Schema.TaggedErrorClass<DesktopTextToSpeechError>()(
  "DesktopTextToSpeechError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const systemSpeech = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SYSTEM_SPEECH_CHANNEL,
  payload: DesktopSystemSpeechInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.textToSpeech.system")(function* (input) {
    if (process.platform !== "linux") {
      return yield* new DesktopTextToSpeechError({
        message: "Desktop system text-to-speech fallback is only available on Linux.",
      });
    }

    if (input.action === "speak") {
      if (input.engine === "kokoro") {
        yield* speakLinuxKokoroSpeech(
          input.text,
          input.rate,
          input.voice?.trim() || KOKORO_DEFAULT_VOICE,
        );
      } else {
        yield* speakLinuxSystemSpeech(input.text, input.rate);
      }
      return;
    }

    if (input.action === "stop") {
      kokoroSpeechGeneration += 1;
      activeKokoroSpeech = false;
      if (kokoroWorker && (yield* isKokoroWorkerReady())) {
        yield* requestKokoroWorker("/stop", {}).pipe(Effect.catch(() => Effect.void));
      }
      yield* stopActiveSystemSpeech();
      return;
    }

    if (activeKokoroSpeech) {
      if (yield* isKokoroWorkerReady()) {
        yield* requestKokoroWorker(`/${input.action}`, {});
      }
      return;
    }

    const handle = activeSystemSpeech;
    if (!handle) return;
    const running = yield* handle.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (!running) return;
    yield* handle.kill({ killSignal: input.action === "pause" ? "SIGSTOP" : "SIGCONT" }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTextToSpeechError({
            message: `Failed to ${input.action} Linux system speech.`,
            cause,
          }),
      ),
    );
  }),
});

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
