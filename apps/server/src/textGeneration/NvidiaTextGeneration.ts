import { type ModelSelection, type NvidiaSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { resolveNvidiaApiKey, resolveNvidiaModel } from "../provider/Layers/NvidiaProvider.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const NvidiaResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
    }),
  ),
});
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeNvidiaTextGeneration = Effect.fn("makeNvidiaTextGeneration")(function* (
  settings: NvidiaSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const apiKey = resolveNvidiaApiKey(settings, environment);
  const endpoint = settings.apiEndpoint?.trim() || "https://integrate.api.nvidia.com/v1";

  const runJson = Effect.fn("NvidiaTextGeneration.runJson")(function* <
    S extends Schema.Top,
  >(input: {
    readonly operation: Operation;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    if (!apiKey) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Missing NVIDIA API key for text generation.",
      });
    }
    const request = HttpClientRequest.post(`${endpoint.replace(/\/+$/, "")}/chat/completions`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJsonUnsafe({
        model: resolveNvidiaModel(input.modelSelection.model || "meta/llama-3.3-70b-instruct"),
        messages: [
          {
            role: "system",
            content: `Return only valid JSON matching this schema: ${String(toJsonSchemaObject(input.outputSchema))}`,
          },
          { role: "user", content: input.prompt },
        ],
        stream: false,
        response_format: { type: "json_object" },
      }),
    );
    const response = yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(NvidiaResponse)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "NVIDIA text generation request failed.",
            cause,
          }),
      ),
    );
    const rawText = response.choices[0]?.message.content;
    if (!rawText) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "NVIDIA returned no structured text.",
      });
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.outputSchema))(
      extractJsonObject(rawText),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `NVIDIA ${input.operation} output did not match the expected schema.`,
            cause,
          }),
      ),
    );
  });

  return {
    generateCommitMessage: (input: TextGeneration.CommitMessageGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildCommitMessagePrompt(input);
        const result = yield* runJson({
          operation: "generateCommitMessage",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { subject: sanitizeCommitSubject(result.subject), body: result.body.trim() };
      }),
    generatePrContent: (input: TextGeneration.PrContentGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt(input);
        const result = yield* runJson({
          operation: "generatePrContent",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(result.title), body: result.body.trim() };
      }),
    generateBranchName: (input: TextGeneration.BranchNameGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt(input);
        const result = yield* runJson({
          operation: "generateBranchName",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { branch: sanitizeBranchFragment(result.branch) };
      }),
    generateThreadTitle: (input: TextGeneration.ThreadTitleGenerationInput) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt(input);
        const result = yield* runJson({
          operation: "generateThreadTitle",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizeThreadTitle(result.title) };
      }),
  };
});
