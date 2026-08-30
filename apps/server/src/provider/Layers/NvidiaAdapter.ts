import {
  type NvidiaSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { callMcpToolForModel, withMcpToolSet } from "../../mcp/McpToolBridge.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeDirectChatAdapter } from "./DirectChatAdapter.ts";
import { resolveNvidiaApiKey, resolveNvidiaModel } from "./NvidiaProvider.ts";

const NvidiaResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  type: Schema.optional(Schema.String),
                  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
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
export interface NvidiaAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

export const makeNvidiaAdapter = Effect.fn("makeNvidiaAdapter")(function* (
  settings: NvidiaSettings,
  options: NvidiaAdapterLiveOptions = {},
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const apiKey = resolveNvidiaApiKey(settings, options.environment);
  const endpoint = settings.apiEndpoint?.trim() || "https://integrate.api.nvidia.com/v1";
  return yield* makeDirectChatAdapter({
    provider: ProviderDriverKind.make("nvidia"),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    defaultModel: "meta/llama-3.3-70b-instruct",
    runChat: ({ threadId, model, history }) =>
      withMcpToolSet(threadId, (toolSet) =>
        Effect.gen(function* () {
          if (!apiKey)
            return yield* new ProviderAdapterRequestError({
              provider: "nvidia",
              method: "chat/completions",
              detail: "Missing NVIDIA API key.",
            });
          const messages: Array<Record<string, unknown>> = history.map((message) => ({
            ...message,
          }));
          let allowToolCalls = toolSet.tools.length > 0;
          for (let round = 0; round < 8; round += 1) {
            const request = HttpClientRequest.post(
              `${endpoint.replace(/\/+$/, "")}/chat/completions`,
            ).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
              HttpClientRequest.bodyJsonUnsafe({
                model: resolveNvidiaModel(model),
                messages,
                stream: false,
                ...(allowToolCalls
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
            const response = yield* client.execute(request).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(NvidiaResponse)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "nvidia",
                    method: "chat/completions",
                    detail: "NVIDIA request failed.",
                    cause,
                  }),
              ),
            );
            const message = response.choices?.[0]?.message;
            const toolCalls = message?.tool_calls ?? [];
            if (toolCalls.length === 0) {
              const answer = message?.content?.trim();
              if (answer) return answer;
              return yield* new ProviderAdapterRequestError({
                provider: "nvidia",
                method: "chat/completions",
                detail: "NVIDIA returned no assistant text.",
              });
            }
            messages.push({
              role: "assistant",
              content: message?.content ?? null,
              tool_calls: toolCalls,
            });
            for (const toolCall of toolCalls) {
              const input = yield* decodeUnknownJson(toolCall.function.arguments).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: "nvidia",
                      method: "tool-call",
                      detail: `NVIDIA returned invalid arguments for '${toolCall.function.name}'.`,
                      cause,
                    }),
                ),
              );
              const result = yield* Effect.promise(() =>
                callMcpToolForModel(toolSet, toolCall.function.name, input),
              );
              if (result.isError) allowToolCalls = false;
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result.content,
              });
            }
          }
          return yield* new ProviderAdapterRequestError({
            provider: "nvidia",
            method: "mcp/tool-call",
            detail: "NVIDIA exceeded the MCP tool-call limit for one turn.",
          });
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: "nvidia",
                method: "mcp/connect",
                detail: "Could not connect to the configured MCP servers.",
                cause,
              }),
        ),
      ),
  });
});
