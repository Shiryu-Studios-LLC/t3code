import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

import { layerTest } from "../../../serverSettings.ts";
import { ProcessRunner } from "../../../processRunner.ts";
import { generateLocalImage } from "./handlers.ts";

const WorkflowRequest = Schema.Struct({
  prompt: Schema.Record(
    Schema.String,
    Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
});

const decodeWorkflowRequest = Schema.decodeUnknownSync(WorkflowRequest);

afterEach(() => vi.restoreAllMocks());

it.effect(
  "sends the selected character checkpoint to ComfyUI and saves its actual render inputs",
  () =>
    Effect.gen(function* () {
      let submitted: typeof WorkflowRequest.Type | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/system_stats") return Response.json({});
        if (url.pathname === "/object_info")
          return Response.json(
            Object.fromEntries(
              [
                "CheckpointLoaderSimple",
                "CLIPTextEncode",
                "EmptyLatentImage",
                "KSampler",
                "VAEDecode",
                "SaveImage",
              ].map((name) => [name, {}]),
            ),
          );
        if (url.pathname === "/prompt") {
          submitted = decodeWorkflowRequest(
            await (input instanceof Request ? input.clone() : new Response(options?.body)).json(),
          );
          return Response.json({ prompt_id: "test-render" });
        }
        if (url.pathname === "/history/test-render")
          return Response.json({
            "test-render": {
              outputs: {
                "7": { images: [{ filename: "render.png", subfolder: "", type: "output" }] },
              },
            },
          });
        if (url.pathname === "/view") return new Response(new Uint8Array([137, 80, 78, 71]));
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      const saved = vi.fn(() => Effect.void);
      const result = yield* generateLocalImage({
        prompt: "1boy, solo, black hair",
        negativePrompt: "magic aura",
        model: "custom",
        checkpointPath: "/models/novaAnimeXL_ilV190.safetensors",
        steps: 26,
        guidance: 4.5,
        width: 768,
        height: 1024,
        seed: 42,
        loras: [],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerTest({
              imageGeneration: {
                engine: "comfyui",
                checkpoint: "nova-furry",
                loras: [
                  {
                    id: "global",
                    name: "unrelated",
                    path: "/furry.safetensors",
                    enabled: true,
                    weight: 1,
                  },
                ],
              },
            }),
            Layer.succeed(ProcessRunner, {
              run: () => Effect.die("Unexpected Diffusers fallback"),
            }),
            FileSystem.layerNoop({
              exists: () => Effect.succeed(true),
              makeDirectory: () => Effect.void,
              writeFile: saved,
            }),
          ),
        ),
      );
      expect(submitted?.prompt["1"]?.inputs.ckpt_name).toBe("novaAnimeXL_ilV190.safetensors");
      expect(submitted?.prompt["5"]?.inputs).toMatchObject({
        sampler_name: "euler_ancestral",
        scheduler: "normal",
        steps: 26,
        cfg: 4.5,
        seed: 42,
      });
      expect(result.generationDetails).toMatchObject({
        checkpoint: "/models/novaAnimeXL_ilV190.safetensors",
        profile: "nova-anime-illustrious",
        loras: [],
        width: 768,
        height: 1024,
        sampler: "euler_ancestral",
      });
      expect(result.generationDetails.positivePrompt).toBe(submitted?.prompt["2"]?.inputs.text);
      expect(result.generationDetails.negativePrompt).toBe(submitted?.prompt["3"]?.inputs.text);
      expect(saved).toHaveBeenCalledOnce();
    }),
);
