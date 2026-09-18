import type { ShiryuGenComfyUiStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";

export async function readComfyUiStatus(): Promise<ShiryuGenComfyUiStatus> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.shiryuGen.comfyUiStatus({ headers: {} })),
    ),
  );
}
