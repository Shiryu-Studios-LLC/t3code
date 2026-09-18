import {
  type OmniRouteSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { callMcpToolForModel, withMcpToolSet } from "../../mcp/McpToolBridge.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { makeDirectChatAdapter } from "./DirectChatAdapter.ts";
import {
  omniRouteOpenAiEndpoint,
  resolveOmniRouteApiKey,
  resolveOmniRouteEndpoint,
} from "./OmniRouteProvider.ts";

const OmniRouteChatResponse = Schema.Struct({
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

function toolArguments(value: string | Readonly<Record<string, unknown>>) {
  return typeof value === "string" ? decodeUnknownJson(value) : Effect.succeed(value);
}

function errorDetail(status: number, body: string, model: string): string {
  const trimmed = body.trim();
  if (status === 401 || status === 403) {
    return "OmniRoute rejected the request. Add the endpoint key from OmniRoute Dashboard → Endpoints.";
  }
  if (status === 402) {
    return `OmniRoute reported a paid/quota-gated route for '${model}'. ShiryuGen Free routes only should use an auto/*:free route.`;
  }
  if (status === 429) {
    return "All currently selected OmniRoute routes are rate-limited or out of quota. OmniRoute will recover them as their free quotas reset.";
  }
  return trimmed || `OmniRoute returned HTTP ${status} for model '${model}'.`;
}

export const makeOmniRouteAdapter = Effect.fn("makeOmniRouteAdapter")(function* (
  settings: OmniRouteSettings,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly instanceId?: ProviderInstanceId;
  } = {},
) {
  const client = yield* HttpClient.HttpClient;
  const provider = ProviderDriverKind.make("omniroute");
  const apiKey = resolveOmniRouteApiKey(settings, options.environment);
  const defaultModel = settings.freeOnly ? "auto/coding:free" : "auto/coding";

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
            let request = HttpClientRequest.post(
              `${omniRouteOpenAiEndpoint(settings)}/chat/completions`,
            ).pipe(
              HttpClientRequest.setHeader("X-Session-Id", threadId),
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
            if (apiKey) request = request.pipe(HttpClientRequest.bearerToken(apiKey));

            const httpResponse = yield* client.execute(request).pipe(
              Effect.timeout("10 minutes"),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "chat/completions",
                    detail: `Could not reach OmniRoute at ${resolveOmniRouteEndpoint(settings)}.`,
                    cause,
                  }),
              ),
            );
            if (httpResponse.status < 200 || httpResponse.status >= 300) {
              const body = yield* httpResponse.text.pipe(Effect.orElseSucceed(() => ""));
              return yield* new ProviderAdapterRequestError({
                provider,
                method: "chat/completions",
                detail: errorDetail(httpResponse.status, body, model),
              });
            }

            const response = yield* HttpClientResponse.schemaBodyJson(OmniRouteChatResponse)(
              httpResponse,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider,
                    method: "chat/completions",
                    detail: "OmniRoute returned an invalid OpenAI-compatible response.",
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
                detail: "OmniRoute returned no assistant text.",
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
                      detail: `OmniRoute returned invalid arguments for '${call.function.name}'.`,
                      cause,
                    }),
                ),
              );
              const result = yield* Effect.promise(() =>
                callMcpToolForModel(toolSet, call.function.name, args),
              );
              messages.push({
                role: "tool",
                tool_call_id: call.id ?? `omniroute-tool-${round}-${index}`,
                content: result.content,
              });
            }
          }

          return yield* new ProviderAdapterRequestError({
            provider,
            method: "mcp/tool-call",
            detail: "OmniRoute exceeded the MCP tool-call limit for one turn.",
          });
        }),
      ).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider,
                method: "mcp/connect",
                detail: "Could not connect OmniRoute to ShiryuGen's tool surface.",
                cause,
              }),
        ),
      ),
  });
});
