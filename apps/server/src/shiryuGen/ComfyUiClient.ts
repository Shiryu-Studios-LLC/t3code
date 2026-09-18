import type { ShiryuGenComfyUiStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";
import type { ComfyApiWorkflow } from "./ComfyWorkflowCompiler.ts";
import { ComfyUiRuntime } from "./ComfyUiRuntime.ts";

const DEFAULT_COMFY_UI_ENDPOINT = "http://127.0.0.1:8188";

const ComfyObjectInfo = Schema.Record(Schema.String, Schema.Unknown);
const ComfySystemStats = Schema.Struct({
  devices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const ComfyPromptResponse = Schema.Struct({
  prompt_id: Schema.String,
});
const ComfyHistoryImage = Schema.Struct({
  filename: Schema.String,
  subfolder: Schema.String,
  type: Schema.String,
});
const ComfyHistoryNodeOutput = Schema.Struct({
  images: Schema.optional(Schema.Array(ComfyHistoryImage)),
});
const ComfyHistoryItem = Schema.Struct({
  outputs: Schema.Record(Schema.String, ComfyHistoryNodeOutput),
});
const ComfyHistoryResponse = Schema.Record(Schema.String, ComfyHistoryItem);

export class ComfyUiExecutionError extends Schema.TaggedErrorClass<ComfyUiExecutionError>()(
  "ComfyUiExecutionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

class ComfyUiPendingError extends Schema.TaggedErrorClass<ComfyUiPendingError>()(
  "ComfyUiPendingError",
  {
    promptId: Schema.String,
  },
) {}

export interface ExecuteComfyWorkflowInput {
  readonly workflow: ComfyApiWorkflow;
  readonly outputPath: string;
}

export interface ExecuteComfyWorkflowResult {
  readonly promptId: string;
  readonly outputPath: string;
}

export class ComfyUiClient extends Context.Service<
  ComfyUiClient,
  {
    readonly status: () => Effect.Effect<ShiryuGenComfyUiStatus>;
    readonly executeWorkflow: (
      input: ExecuteComfyWorkflowInput,
    ) => Effect.Effect<ExecuteComfyWorkflowResult, ComfyUiExecutionError>;
  }
>()("t3/shiryuGen/ComfyUiClient") {
  static readonly layer = Layer.effect(
    ComfyUiClient,
    Effect.gen(function* () {
      const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const settingsService = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ComfyUiRuntime;

      const readEndpoint = Effect.fn("ComfyUiClient.readEndpoint")(function* () {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new ComfyUiExecutionError({
                message: "Could not read ShiryuGen image engine settings.",
                cause,
              }),
          ),
        );
        return (
          settings.imageGeneration.comfyUiEndpoint.trim() || DEFAULT_COMFY_UI_ENDPOINT
        ).replace(/\/+$/, "");
      });

      const fetchObjectInfo = Effect.fn("ComfyUiClient.fetchObjectInfo")(function* (
        endpoint: string,
      ) {
        return yield* httpClient.execute(HttpClientRequest.get(`${endpoint}/object_info`)).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ComfyObjectInfo)),
          Effect.mapError(
            (cause) =>
              new ComfyUiExecutionError({
                message: "Could not read ComfyUI node capabilities.",
                cause,
              }),
          ),
        );
      });

      const status = Effect.fn("ComfyUiClient.status")(function* () {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const runtimeSnapshot = yield* runtime.snapshot;
        if (settings === null) {
          return {
            endpoint: DEFAULT_COMFY_UI_ENDPOINT,
            reachable: false,
            nodeCount: 0,
            deviceName: null,
            error: "Could not read ShiryuGen image engine settings.",
            runtimeState: "failed",
            managedByShiryuGen: runtimeSnapshot.managedByShiryuGen,
          } satisfies ShiryuGenComfyUiStatus;
        }

        const endpoint = (
          settings.imageGeneration.comfyUiEndpoint.trim() || DEFAULT_COMFY_UI_ENDPOINT
        ).replace(/\/+$/, "");
        return yield* Effect.all(
          [
            httpClient
              .execute(HttpClientRequest.get(`${endpoint}/system_stats`))
              .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ComfySystemStats))),
            fetchObjectInfo(endpoint),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(
            ([systemStats, objectInfo]) =>
              ({
                endpoint,
                reachable: true,
                nodeCount: Object.keys(objectInfo).length,
                deviceName: systemStats.devices?.[0]?.name ?? null,
                error: null,
                runtimeState: "ready",
                managedByShiryuGen: runtimeSnapshot.managedByShiryuGen,
              }) satisfies ShiryuGenComfyUiStatus,
          ),
          Effect.catch(() =>
            Effect.succeed({
              endpoint,
              reachable: false,
              nodeCount: 0,
              deviceName: null,
              error:
                runtimeSnapshot.state === "starting"
                  ? "ShiryuGen is starting Headless ComfyUI…"
                  : (runtimeSnapshot.error ??
                    "Headless ComfyUI is not reachable at the configured endpoint."),
              runtimeState: runtimeSnapshot.state,
              managedByShiryuGen: runtimeSnapshot.managedByShiryuGen,
            } satisfies ShiryuGenComfyUiStatus),
          ),
        );
      });

      const executeWorkflow = Effect.fn("ComfyUiClient.executeWorkflow")(function* (
        input: ExecuteComfyWorkflowInput,
      ) {
        yield* runtime.ensureStarted;
        const endpoint = yield* readEndpoint();
        const objectInfo = yield* fetchObjectInfo(endpoint);
        const missingNodes = [
          ...new Set(Object.values(input.workflow).map((node) => node.class_type)),
        ].filter((nodeName) => !(nodeName in objectInfo));
        if (missingNodes.length > 0) {
          return yield* new ComfyUiExecutionError({
            message: `ComfyUI is missing required nodes: ${missingNodes.join(", ")}.`,
          });
        }

        const queued = yield* httpClient
          .execute(
            HttpClientRequest.post(`${endpoint}/prompt`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ prompt: input.workflow }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ComfyPromptResponse)),
            Effect.mapError(
              (cause) =>
                new ComfyUiExecutionError({
                  message: "ComfyUI rejected the ShiryuGen workflow.",
                  cause,
                }),
            ),
          );
        const promptId = queued.prompt_id;

        const fetchCompletedImage = Effect.fn("ComfyUiClient.fetchCompletedImage")(function* () {
          const history = yield* httpClient
            .execute(HttpClientRequest.get(`${endpoint}/history/${encodeURIComponent(promptId)}`))
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ComfyHistoryResponse)),
              Effect.mapError(
                (cause) =>
                  new ComfyUiExecutionError({
                    message: "Could not read ComfyUI workflow history.",
                    cause,
                  }),
              ),
            );
          const entry = history[promptId];
          if (!entry) {
            return yield* new ComfyUiPendingError({ promptId });
          }
          for (const node of Object.values(entry.outputs)) {
            const image = node.images?.[0];
            if (image) return image;
          }
          return yield* new ComfyUiPendingError({ promptId });
        });

        const image = yield* fetchCompletedImage().pipe(
          Effect.retry({
            while: (error) => error._tag === "ComfyUiPendingError",
            schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: "3 minutes" })),
          }),
          Effect.mapError((error) =>
            error._tag === "ComfyUiPendingError"
              ? new ComfyUiExecutionError({
                  message: `ComfyUI workflow ${promptId} did not finish within 3 minutes.`,
                })
              : error,
          ),
        );

        const viewUrl = new URL(`${endpoint}/view`);
        viewUrl.searchParams.set("filename", image.filename);
        viewUrl.searchParams.set("subfolder", image.subfolder);
        viewUrl.searchParams.set("type", image.type);
        const response = yield* httpClient.execute(HttpClientRequest.get(viewUrl.toString())).pipe(
          Effect.mapError(
            (cause) =>
              new ComfyUiExecutionError({
                message: "Could not download the completed image from ComfyUI.",
                cause,
              }),
          ),
        );
        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError(
            (cause) =>
              new ComfyUiExecutionError({
                message: "ComfyUI returned an unreadable image.",
                cause,
              }),
          ),
        );
        yield* fileSystem.writeFile(input.outputPath, new Uint8Array(buffer)).pipe(
          Effect.mapError(
            (cause) =>
              new ComfyUiExecutionError({
                message: `Could not save ComfyUI output to ${input.outputPath}.`,
                cause,
              }),
          ),
        );
        return { promptId, outputPath: input.outputPath } satisfies ExecuteComfyWorkflowResult;
      });

      return ComfyUiClient.of({ status, executeWorkflow });
    }),
  );
}
