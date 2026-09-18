import {
  type OllamaSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { callMcpToolForModel, withMcpToolSet } from "../../mcp/McpToolBridge.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { makeDirectChatAdapter } from "./DirectChatAdapter.ts";
import { resolveOllamaEndpoint } from "./OllamaProvider.ts";

const OllamaChatResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  id: Schema.optional(Schema.String),
                  type: Schema.optional(Schema.String),
                  function: Schema.Struct({
                    name: Schema.String,
                    arguments: Schema.Union([
                      Schema.String,
                      Schema.Record(Schema.String, Schema.Unknown),
                    ]),
                  }),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
});

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function openAiEndpoint(settings: OllamaSettings): string {
  const endpoint = resolveOllamaEndpoint(settings);
  return endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
}

function toolArguments(value: string | Readonly<Record<string, unknown>>) {
  return typeof value === "string" ? decodeUnknownJson(value) : Effect.succeed(value);
}

export const makeOllamaAdapter = Effect.fn("makeOllamaAdapter")(function* (
  settings: OllamaSettings,
  options: { readonly instanceId?: ProviderInstanceId } = {},
) {
  const client = yield* HttpClient.HttpClient;
  const provider = ProviderDriverKind.make("ollama");
  const defaultModel = settings.customModels[0] ?? "qwen3:8b";

  return yield* makeDirectChatAdapter({
    provider,
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    defaultModel,
    runChat: ({ threadId, model, history, cwd }) =>
      withMcpToolSet(threadId, cwd, (toolSet) =>
        Effect.gen(function* () {
          const messages: Array<Record<string, unknown>> = history.map((message) => ({
            ...message,
          }));
          for (let round = 0; round < 8; round += 1) {
            const request = HttpClientRequest.post(
              `${openAiEndpoint(settings)}/chat/completions`,
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                model,
                messages,
                stream: false,
                ...(toolSet.tools.length > 0
                  ? {
                      tools: toolSet.tools.map((tool) => ({
                        type: "function",
                        function: {
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema,
                        },
                      })),
                      tool_choice: "auto",
                    }
                  : {}),
              }),
            );
            const httpResponse = yield* client.execute(request).pipe(
              Effect.timeout("10 minutes"),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "chat/completions",
                    detail: `Could not reach Ollama at ${resolveOllamaEndpoint(settings)}.`,
                    cause,
                  }),
              ),
            );
            if (httpResponse.status < 200 || httpResponse.status >= 300) {
              const detail = yield* httpResponse.text.pipe(Effect.orElseSucceed(() => ""));
              return yield* new ProviderAdapterRequestError({
                provider,
                method: "chat/completions",
                detail:
                  detail.trim() ||
                  `Ollama returned HTTP ${httpResponse.status} for model '${model}'. Make sure that model is pulled locally.`,
              });
            }

            const response = yield* HttpClientResponse.schemaBodyJson(OllamaChatResponse)(
              httpResponse,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "chat/completions",
                    detail: "Ollama returned an invalid OpenAI-compatible response.",
                    cause,
                  }),
              ),
            );
            const message = response.choices?.[0]?.message;
            const calls = message?.tool_calls ?? [];
            if (calls.length === 0) {
              const text = message?.content?.trim();
              if (text) return text;
              return yield* new ProviderAdapterRequestError({
                provider,
                method: "chat/completions",
                detail: "Ollama returned no assistant text.",
              });
            }

            messages.push({
              role: "assistant",
              content: message?.content ?? null,
              tool_calls: calls,
            });
            for (let index = 0; index < calls.length; index += 1) {
              const call = calls[index]!;
              const args = yield* toolArguments(call.function.arguments).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider,
                      method: "tool-call",
                      detail: `Ollama returned invalid arguments for '${call.function.name}'.`,
                      cause,
                    }),
                ),
              );
              const result = yield* Effect.promise(() =>
                callMcpToolForModel(toolSet, call.function.name, args),
              );
              messages.push({
                role: "tool",
                tool_call_id: call.id ?? `ollama-tool-${round}-${index}`,
                content: result.content,
              });
            }
          }

          return yield* new ProviderAdapterRequestError({
            provider,
            method: "mcp/tool-call",
            detail: "Ollama exceeded the MCP tool-call limit for one turn.",
          });
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider,
                method: "mcp/connect",
                detail: "Could not connect Ollama to T3's tool surface.",
                cause,
              }),
        ),
      ),
  });
});
