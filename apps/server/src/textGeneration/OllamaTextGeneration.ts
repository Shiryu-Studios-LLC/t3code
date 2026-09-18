import { type ModelSelection, type OllamaSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveOllamaEndpoint } from "../provider/Layers/OllamaProvider.ts";
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

const OllamaResponse = Schema.Struct({
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

export const makeOllamaTextGeneration = Effect.fn("makeOllamaTextGeneration")(function* (
  settings: OllamaSettings,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const root = resolveOllamaEndpoint(settings);
  const endpoint = root.endsWith("/v1") ? root : `${root}/v1`;

  const runJson = Effect.fn("OllamaTextGeneration.runJson")(function* <
    S extends Schema.Top,
  >(input: {
    readonly operation: Operation;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = input.modelSelection.model || settings.customModels[0] || "qwen3:8b";
    const request = HttpClientRequest.post(`${endpoint}/chat/completions`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model,
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
      Effect.timeout("5 minutes"),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaResponse)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Ollama text generation failed for model '${model}'.`,
            cause,
          }),
      ),
    );
    const rawText = response.choices[0]?.message.content;
    if (!rawText) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Ollama returned no structured text.",
      });
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.outputSchema))(
      extractJsonObject(rawText),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Ollama ${input.operation} output did not match the expected schema.`,
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
