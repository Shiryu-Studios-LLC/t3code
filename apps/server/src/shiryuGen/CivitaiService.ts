import type {
  ShiryuGenCivitaiModelSummary,
  ShiryuGenCivitaiSearchInput,
  ShiryuGenCivitaiSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveCivitaiInstallTarget, selectPrimaryCivitaiFile } from "./CivitaiModelRouting.ts";

const CIVITAI_API_BASE = "https://civitai.com/api/v1";
export const CIVITAI_API_KEY_SECRET = "shiryugen-civitai-api-key";

const CivitaiImage = Schema.Struct({
  url: Schema.String,
});

const CivitaiFile = Schema.Struct({
  id: Schema.optional(Schema.Number),
  name: Schema.String,
  type: Schema.optional(Schema.String),
  sizeKB: Schema.optional(Schema.Number),
  primary: Schema.optional(Schema.Boolean),
  pickleScanResult: Schema.optional(Schema.NullOr(Schema.String)),
  virusScanResult: Schema.optional(Schema.NullOr(Schema.String)),
  downloadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  hashes: Schema.optional(
    Schema.Struct({
      SHA256: Schema.optional(Schema.String),
    }),
  ),
});

const CivitaiVersion = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  baseModel: Schema.optional(Schema.NullOr(Schema.String)),
  trainedWords: Schema.optional(Schema.Array(Schema.String)),
  downloadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  files: Schema.optional(Schema.Array(CivitaiFile)),
  images: Schema.optional(Schema.Array(CivitaiImage)),
});

const CivitaiModel = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  type: Schema.String,
  creator: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        username: Schema.String,
      }),
    ),
  ),
  stats: Schema.optional(
    Schema.Struct({
      downloadCount: Schema.optional(Schema.Number),
      favoriteCount: Schema.optional(Schema.Number),
      rating: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
  modelVersions: Schema.optional(Schema.Array(CivitaiVersion)),
});

const CivitaiModelsResponse = Schema.Struct({
  items: Schema.Array(CivitaiModel),
  metadata: Schema.optional(
    Schema.Struct({
      nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

export class CivitaiServiceError extends Schema.TaggedErrorClass<CivitaiServiceError>()(
  "CivitaiServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class CivitaiService extends Context.Service<
  CivitaiService,
  {
    readonly getConfigStatus: () => Effect.Effect<
      { readonly configured: boolean },
      CivitaiServiceError
    >;
    readonly updateApiKey: (
      apiKey: string,
    ) => Effect.Effect<{ readonly configured: boolean }, CivitaiServiceError>;
    readonly searchModels: (
      input: ShiryuGenCivitaiSearchInput,
    ) => Effect.Effect<ShiryuGenCivitaiSearchResult, CivitaiServiceError>;
  }
>()("t3/shiryuGen/CivitaiService") {
  static readonly layer = Layer.effect(
    CivitaiService,
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const textEncoder = new TextEncoder();
      const textDecoder = new TextDecoder();

      const readApiKey = Effect.fn("CivitaiService.readApiKey")(function* () {
        const stored = yield* secrets.get(CIVITAI_API_KEY_SECRET).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiServiceError({
                message: "Could not read the stored CivitAI API key.",
                cause,
              }),
          ),
        );
        if (Option.isNone(stored)) return "";
        return textDecoder.decode(stored.value).trim();
      });

      const getConfigStatus = Effect.fn("CivitaiService.getConfigStatus")(function* () {
        const apiKey = yield* readApiKey();
        return { configured: apiKey.length > 0 };
      });

      const updateApiKey = Effect.fn("CivitaiService.updateApiKey")(function* (apiKey: string) {
        const normalized = apiKey.trim();
        if (!normalized) {
          yield* secrets.remove(CIVITAI_API_KEY_SECRET).pipe(
            Effect.mapError(
              (cause) =>
                new CivitaiServiceError({
                  message: "Could not remove the stored CivitAI API key.",
                  cause,
                }),
            ),
          );
          return { configured: false };
        }
        yield* secrets.set(CIVITAI_API_KEY_SECRET, textEncoder.encode(normalized)).pipe(
          Effect.mapError(
            (cause) =>
              new CivitaiServiceError({
                message: "Could not store the CivitAI API key.",
                cause,
              }),
          ),
        );
        return { configured: true };
      });

      const searchModels = Effect.fn("CivitaiService.searchModels")(function* (
        input: ShiryuGenCivitaiSearchInput,
      ): Effect.fn.Return<ShiryuGenCivitaiSearchResult, CivitaiServiceError> {
        const url = new URL(`${CIVITAI_API_BASE}/models`);
        const query = input.query.trim();
        const type = input.type.trim();
        const baseModel = input.baseModel.trim();
        const sort = input.sort.trim();
        const cursor = input.cursor.trim();
        const limit = Math.max(1, Math.min(50, Math.round(input.limit || 24)));
        url.searchParams.set("limit", String(limit));
        if (query) url.searchParams.set("query", query);
        if (type) url.searchParams.set("types", type);
        if (baseModel) url.searchParams.set("baseModels", baseModel);
        if (sort) url.searchParams.set("sort", sort);
        if (cursor) url.searchParams.set("cursor", cursor);

        const apiKey = yield* readApiKey();
        let request = HttpClientRequest.get(url.toString());
        if (apiKey) request = HttpClientRequest.bearerToken(apiKey)(request);

        const response = yield* httpClient.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CivitaiModelsResponse)),
          Effect.mapError(
            (cause) =>
              new CivitaiServiceError({
                message: "CivitAI model search failed.",
                cause,
              }),
          ),
        );

        const items: ShiryuGenCivitaiModelSummary[] = response.items.map((model) => {
          const version = model.modelVersions?.[0] ?? null;
          const stats = model.stats;
          const primaryFile = selectPrimaryCivitaiFile(version?.files);
          const installTarget = resolveCivitaiInstallTarget(model.type, version?.baseModel ?? null);
          return {
            id: model.id,
            name: model.name,
            type: model.type,
            creatorName: model.creator?.username ?? null,
            versionId: version?.id ?? null,
            versionName: version?.name ?? null,
            baseModel: version?.baseModel ?? null,
            trainedWords: version?.trainedWords ?? [],
            previewImageUrl: version?.images?.[0]?.url ?? null,
            downloadUrl: primaryFile?.downloadUrl ?? version?.downloadUrl ?? null,
            primaryFileName: primaryFile?.name ?? null,
            primaryFileSizeBytes: Math.max(0, Math.round((primaryFile?.sizeKB ?? 0) * 1024)),
            primaryFileSha256: primaryFile?.hashes?.SHA256 ?? null,
            installSupported: Boolean(version && primaryFile && installTarget),
            installTarget,
            downloadCount: stats?.downloadCount ?? 0,
            favoriteCount: stats?.favoriteCount ?? 0,
            rating: stats?.rating ?? null,
          };
        });

        return {
          items,
          nextCursor: response.metadata?.nextCursor ?? null,
        };
      });

      return CivitaiService.of({ getConfigStatus, updateApiKey, searchModels });
    }),
  );
}
