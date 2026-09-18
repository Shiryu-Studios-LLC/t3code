import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpInternalServerError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { CivitaiService } from "./CivitaiService.ts";
import { CivitaiInstallManager } from "./CivitaiInstallManager.ts";
import { CivitaiModelLibrary } from "./CivitaiModelLibrary.ts";
import { ComfyUiClient } from "./ComfyUiClient.ts";

const mapCivitaiError = (error: { readonly message: string }) =>
  new EnvironmentHttpInternalServerError({ message: error.message });

export const shiryuGenHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "shiryuGen",
  Effect.fnUntraced(function* (handlers) {
    const civitai = yield* CivitaiService;
    const installManager = yield* CivitaiInstallManager;
    const modelLibrary = yield* CivitaiModelLibrary;
    const comfyUi = yield* ComfyUiClient;
    return handlers
      .handle(
        "comfyUiStatus",
        Effect.fn("environment.shiryuGen.comfyUiStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* comfyUi.status();
        }),
      )
      .handle(
        "civitaiConfig",
        Effect.fn("environment.shiryuGen.civitaiConfig")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* civitai.getConfigStatus().pipe(Effect.mapError(mapCivitaiError));
        }),
      )
      .handle(
        "updateCivitaiConfig",
        Effect.fn("environment.shiryuGen.updateCivitaiConfig")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* civitai
            .updateApiKey(args.payload.apiKey)
            .pipe(Effect.mapError(mapCivitaiError));
        }),
      )
      .handle(
        "searchCivitaiModels",
        Effect.fn("environment.shiryuGen.searchCivitaiModels")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* civitai.searchModels(args.payload).pipe(Effect.mapError(mapCivitaiError));
        }),
      )
      .handle(
        "installedCivitaiModels",
        Effect.fn("environment.shiryuGen.installedCivitaiModels")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* modelLibrary.listInstalled().pipe(Effect.mapError(mapCivitaiError));
        }),
      )
      .handle(
        "installCivitaiModel",
        Effect.fn("environment.shiryuGen.installCivitaiModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* installManager
            .installAndWait(args.payload.modelId, args.payload.versionId)
            .pipe(Effect.mapError(mapCivitaiError));
        }),
      )
      .handle(
        "queueCivitaiModelInstall",
        Effect.fn("environment.shiryuGen.queueCivitaiModelInstall")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* installManager.queue(args.payload.modelId, args.payload.versionId);
        }),
      )
      .handle(
        "civitaiModelInstallTasks",
        Effect.fn("environment.shiryuGen.civitaiModelInstallTasks")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* installManager.list();
        }),
      )
      .handle(
        "uninstallCivitaiModel",
        Effect.fn("environment.shiryuGen.uninstallCivitaiModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (yield* installManager.hasActiveModel(args.payload.modelId)) {
            return yield* new EnvironmentHttpInternalServerError({
              message: "Wait for this model install to finish before removing it.",
            });
          }
          return yield* modelLibrary
            .uninstall(args.payload.modelId)
            .pipe(Effect.mapError(mapCivitaiError));
        }),
      );
  }),
);
