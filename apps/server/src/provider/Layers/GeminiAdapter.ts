import {
  type GeminiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { withMcpToolSet } from "../../mcp/McpToolBridge.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeDirectChatAdapter } from "./DirectChatAdapter.ts";
import {
  resolveGeminiApiEndpoint,
  resolveGeminiApiKey,
  resolveGeminiModel,
} from "./GeminiProvider.ts";

const GeminiResponse = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Struct({
            parts: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  text: Schema.optional(Schema.String),
                  functionCall: Schema.optional(
                    Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
});
export interface GeminiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

export const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  settings: GeminiSettings,
  options: GeminiAdapterLiveOptions = {},
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const apiKey = resolveGeminiApiKey(settings, options.environment);
  const endpoint = resolveGeminiApiEndpoint(settings);
  return yield* makeDirectChatAdapter({
    provider: ProviderDriverKind.make("gemini"),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    defaultModel: "gemini-2.5-flash",
    runChat: ({ threadId, model, history }) =>
      withMcpToolSet(threadId, (toolSet) =>
        Effect.gen(function* () {
          if (!apiKey)
            return yield* new ProviderAdapterRequestError({
              provider: "gemini",
              method: "generateContent",
              detail: "Missing Gemini API key.",
            });
          const contents: Array<Record<string, unknown>> = history.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          }));
          const resolvedModel = resolveGeminiModel(model);
          for (let round = 0; round < 8; round += 1) {
            const request = HttpClientRequest.post(
              `${endpoint}/models/${encodeURIComponent(resolvedModel)}:generateContent`,
            ).pipe(
              HttpClientRequest.setUrlParam("key", apiKey),
              HttpClientRequest.bodyJsonUnsafe({
                contents,
                ...(toolSet.tools.length > 0
                  ? {
                      tools: [
                        {
                          functionDeclarations: toolSet.tools.map((tool) => ({
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.inputSchema,
                          })),
                        },
                      ],
                    }
                  : {}),
              }),
            );
            const response = yield* client.execute(request).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(GeminiResponse)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "gemini",
                    method: "generateContent",
                    detail: "Gemini request failed.",
                    cause,
                  }),
              ),
            );
            const parts = response.candidates?.[0]?.content?.parts ?? [];
            const functionCalls = parts.flatMap((part) =>
              part.functionCall ? [part.functionCall] : [],
            );
            if (functionCalls.length === 0) {
              const text = parts
                .map((part) => part.text ?? "")
                .join("")
                .trim();
              if (text) return text;
              return yield* new ProviderAdapterRequestError({
                provider: "gemini",
                method: "generateContent",
                detail: "Gemini returned no assistant text.",
              });
            }
            contents.push({ role: "model", parts });
            const responses: Array<Record<string, unknown>> = [];
            for (const functionCall of functionCalls) {
              const result = yield* Effect.tryPromise({
                try: () => toolSet.call(functionCall.name, functionCall.args ?? {}),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "gemini",
                    method: "mcp/tool-call",
                    detail: `MCP tool '${functionCall.name}' failed.`,
                    cause,
                  }),
              });
              responses.push({
                functionResponse: {
                  name: functionCall.name,
                  response: { result },
                },
              });
            }
            contents.push({ role: "user", parts: responses });
          }
          return yield* new ProviderAdapterRequestError({
            provider: "gemini",
            method: "mcp/tool-call",
            detail: "Gemini exceeded the MCP tool-call limit for one turn.",
          });
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: "gemini",
                method: "mcp/connect",
                detail: "Could not connect to the configured MCP servers.",
                cause,
              }),
        ),
      ),
  });
});
