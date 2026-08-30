import { type GeminiSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  resolveGeminiApiEndpoint,
  resolveGeminiApiKey,
  resolveGeminiModel,
} from "../provider/Layers/GeminiProvider.ts";
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

const GeminiResponse = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
            ),
          }),
        ),
      }),
    ),
  ),
});
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeGeminiTextGeneration = Effect.fn("makeGeminiTextGeneration")(function* (
  settings: GeminiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const apiKey = resolveGeminiApiKey(settings, environment);
  const endpoint = resolveGeminiApiEndpoint(settings);

  const runJson = Effect.fn("GeminiTextGeneration.runJson")(function* <
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
        detail: "Missing Gemini API key for text generation.",
      });
    }
    const model = resolveGeminiModel(input.modelSelection.model || "gemini-2.5-flash");
    const request = HttpClientRequest.post(
      `${endpoint}/models/${encodeURIComponent(model)}:generateContent`,
    ).pipe(
      HttpClientRequest.setUrlParam("key", apiKey),
      HttpClientRequest.bodyJsonUnsafe({
        systemInstruction: {
          parts: [{ text: "Return only valid JSON matching the requested schema." }],
        },
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: toJsonSchemaObject(input.outputSchema),
        },
      }),
    );
    const response = yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GeminiResponse)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Gemini text generation request failed.",
            cause,
          }),
      ),
    );
    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Gemini returned no structured text.",
      });
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.outputSchema))(
      extractJsonObject(rawText),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Gemini ${input.operation} output did not match the expected schema.`,
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
