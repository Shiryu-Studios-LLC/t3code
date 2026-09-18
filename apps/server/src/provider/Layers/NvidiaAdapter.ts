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

export function isRetryableNvidiaStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export const makeNvidiaAdapter = Effect.fn("makeNvidiaAdapter")(function* (
  settings: NvidiaSettings,
  options: NvidiaAdapterLiveOptions = {},
) {
  const client = yield* HttpClient.HttpClient;
  const apiKey = resolveNvidiaApiKey(settings, options.environment);
  const endpoint = settings.apiEndpoint?.trim() || "https://integrate.api.nvidia.com/v1";
  return yield* makeDirectChatAdapter({
    provider: ProviderDriverKind.make("nvidia"),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    defaultModel: "deepseek-ai/deepseek-v4-flash-0731",
    runChat: ({ threadId, model, history, cwd }) =>
      withMcpToolSet(threadId, cwd, (toolSet) =>
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
            let httpResponse = yield* client.execute(request).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "nvidia",
                    method: "chat/completions",
                    detail: "Could not reach NVIDIA API.",
                    cause,
                  }),
              ),
            );

            // NVIDIA's gateway commonly returns short-lived overload responses.
            // Retry once so a momentary capacity spike does not immediately fail the turn.
            if (isRetryableNvidiaStatus(httpResponse.status)) {
              yield* Effect.sleep(httpResponse.status === 429 ? "2 seconds" : "1 second");
              httpResponse = yield* client.execute(request).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: "nvidia",
                      method: "chat/completions",
                      detail: "Could not reach NVIDIA API on retry.",
                      cause,
                    }),
                ),
              );
            }

            if (httpResponse.status < 200 || httpResponse.status >= 300) {
              const bodyText = yield* httpResponse.text.pipe(Effect.orElseSucceed(() => ""));
              let errorDetail = `NVIDIA API returned status ${httpResponse.status}.`;
              try {
                // @effect-diagnostics-next-line preferSchemaOverJson:off - NVIDIA error bodies vary by upstream gateway.
                const parsed = JSON.parse(bodyText);
                if (parsed.detail) errorDetail = String(parsed.detail);
                else if (parsed.message) errorDetail = String(parsed.message);
                else if (parsed.error?.message) errorDetail = String(parsed.error.message);
                else if (parsed.error) errorDetail = String(parsed.error);
              } catch {
                if (bodyText.trim()) errorDetail = bodyText.trim();
              }
              if (httpResponse.status === 429) {
                errorDetail = `NVIDIA Rate Limit / Quota Exceeded (HTTP 429): ${errorDetail}\n\nThis happens when:\n1. NVIDIA free tier credits (1,000 credits) on your account have been used up or expired.\n2. Too many requests were sent in a short time (RPM/TPM limit).\n3. The model (${resolveNvidiaModel(model)}) is experiencing high traffic on build.nvidia.com.\n\nTo resolve this, wait 10-15 seconds and try again, switch to another model (e.g. DeepSeek V4 Flash or Nemotron), or check your remaining credits at build.nvidia.com.`;
              } else if ([502, 503, 504].includes(httpResponse.status)) {
                errorDetail = `NVIDIA is temporarily overloaded (HTTP ${httpResponse.status}). Try again shortly or switch to another NVIDIA model.`;
              } else if (
                errorDetail.includes("Function") &&
                errorDetail.includes("Not found for account")
              ) {
                errorDetail = `${errorDetail}\n\nNote: This NVIDIA error indicates that your account lacks "Public API Endpoints" / model invocation permissions on build.nvidia.com. Please ensure account & phone verification are complete at build.nvidia.com, or contact help@build.nvidia.com with your Account ID to enable endpoint access.`;
              }
              return yield* new ProviderAdapterRequestError({
                provider: "nvidia",
                method: "chat/completions",
                detail: errorDetail,
              });
            }
            const response = yield* HttpClientResponse.schemaBodyJson(NvidiaResponse)(
              httpResponse,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "nvidia",
                    method: "chat/completions",
                    detail: "Invalid response structure from NVIDIA API.",
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
