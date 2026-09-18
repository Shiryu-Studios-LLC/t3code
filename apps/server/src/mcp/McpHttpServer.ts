import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { ExtensionManagementToolkitHandlersLive } from "./toolkits/extensions/handlers.ts";
import { ExtensionManagementToolkit } from "./toolkits/extensions/tools.ts";
import { ImageGenerationToolkitHandlersLive } from "./toolkits/imageGeneration/handlers.ts";
import { GenerateImageTool, ImageGenerationToolkit } from "./toolkits/imageGeneration/tools.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const ExtensionManagementToolkitRegistrationLive = McpServer.toolkit(
  ExtensionManagementToolkit,
).pipe(Layer.provide(ExtensionManagementToolkitHandlersLive));

const registerImageGeneration = Effect.fn("McpHttpServer.registerImageGeneration")(function* () {
  const server = yield* McpServer.McpServer;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const runner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettingsService;
  const built = yield* ImageGenerationToolkit;
  const tool = GenerateImageTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("t3_generate_image", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ServerSettingsService, serverSettings),
          Effect.flatMap(({ encodedResult }) => {
            const result = encodedResult as {
              readonly outputPath: string;
              readonly model: string;
              readonly width: number;
              readonly height: number;
              readonly steps: number;
              readonly guidance: number;
              readonly seed: number;
              readonly elapsedMs: number;
            };
            return fs.readFile(result.outputPath).pipe(
              Effect.map(
                (imageBytes) =>
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: result,
                    content: [
                      { type: "text", text: JSON.stringify(result) },
                      { type: "image", data: imageBytes, mimeType: "image/png" },
                    ],
                  }),
              ),
            );
          }),
          Effect.catch((cause) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: {
                  error: cause instanceof Error ? cause.message : "Local image generation failed.",
                },
                content: [
                  {
                    type: "text",
                    text: cause instanceof Error ? cause.message : "Local image generation failed.",
                  },
                ],
              }),
            ),
          ),
        );
      }),
  });
});

export const ImageGenerationToolkitRegistrationLive = Layer.effectDiscard(
  registerImageGeneration(),
).pipe(Layer.provide(ImageGenerationToolkitHandlersLive), Layer.provide(ProcessRunner.layer));

const swarmToolResult = (
  isError: boolean,
  payload: Record<string, unknown>,
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

const registerSwarmTools = Effect.fn("McpHttpServer.registerSwarmTools")(function* () {
  const server = yield* McpServer.McpServer;
  const providerService = yield* ProviderService;

  yield* server.addTool({
    annotations: Context.empty(),
    tool: new McpSchema.Tool({
      name: "t3_swarm_launch_agent",
      description:
        "Launch a ShiryuGen Swarm worker for a parallel task. The worker inherits the current thread's provider, model, permissions, and workspace. Use this when independent work can run concurrently.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Complete task for the worker to execute." },
          title: { type: "string", description: "Optional short worker title." },
        },
        required: ["task"],
      },
      annotations: {
        title: "Launch Swarm worker",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    }),
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        const input = (payload ?? {}) as { readonly task?: unknown; readonly title?: unknown };
        const task = typeof input.task === "string" ? input.task.trim() : "";
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!task) return Effect.succeed(swarmToolResult(true, { error: "task is required" }));
        return providerService
          .launchSwarmAgent({
            threadId: invocation.threadId,
            task,
            ...(title ? { title } : {}),
            workspaceStrategy: "shared",
          })
          .pipe(
            Effect.match({
              onFailure: (error) =>
                swarmToolResult(true, {
                  error: error instanceof Error ? error.message : String(error),
                }),
              onSuccess: (result) =>
                swarmToolResult(false, {
                  ok: true,
                  agentId: result.agentId,
                  title: result.title,
                  workspaceStrategy: result.workspaceStrategy,
                  ...(result.workspacePath ? { workspacePath: result.workspacePath } : {}),
                }),
            }),
          );
      }),
  });

  yield* server.addTool({
    annotations: Context.empty(),
    tool: new McpSchema.Tool({
      name: "t3_swarm_message_agent",
      description: "Send an additional instruction to a currently running ShiryuGen Swarm worker.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent id returned by t3_swarm_launch_agent." },
          message: { type: "string", description: "Instruction to queue for the worker." },
        },
        required: ["agentId", "message"],
      },
      annotations: {
        title: "Message Swarm worker",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    }),
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        const input = (payload ?? {}) as {
          readonly agentId?: unknown;
          readonly message?: unknown;
        };
        const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
        const message = typeof input.message === "string" ? input.message.trim() : "";
        if (!agentId || !message) {
          return Effect.succeed(
            swarmToolResult(true, { error: "agentId and message are required" }),
          );
        }
        return providerService
          .messageSwarmAgent({ threadId: invocation.threadId, agentId, message })
          .pipe(
            Effect.match({
              onFailure: (error) =>
                swarmToolResult(true, {
                  error: error instanceof Error ? error.message : String(error),
                }),
              onSuccess: () => swarmToolResult(false, { ok: true, agentId }),
            }),
          );
      }),
  });

  yield* server.addTool({
    annotations: Context.empty(),
    tool: new McpSchema.Tool({
      name: "t3_swarm_stop_agent",
      description: "Stop a currently running ShiryuGen Swarm worker.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent id returned by t3_swarm_launch_agent." },
        },
        required: ["agentId"],
      },
      annotations: {
        title: "Stop Swarm worker",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        const input = (payload ?? {}) as { readonly agentId?: unknown };
        const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
        if (!agentId) {
          return Effect.succeed(swarmToolResult(true, { error: "agentId is required" }));
        }
        return providerService.stopSwarmAgent({ threadId: invocation.threadId, agentId }).pipe(
          Effect.match({
            onFailure: (error) =>
              swarmToolResult(true, {
                error: error instanceof Error ? error.message : String(error),
              }),
            onSuccess: () => swarmToolResult(false, { ok: true, agentId }),
          }),
        );
      }),
  });
});

export const SwarmToolkitRegistrationLive = Layer.effectDiscard(registerSwarmTools());

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Studio",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  ExtensionManagementToolkitRegistrationLive,
  ImageGenerationToolkitRegistrationLive,
  SwarmToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
