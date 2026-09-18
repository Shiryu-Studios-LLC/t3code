import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRuntimeStatusIssues, normalizeRuntimeIssueMessage } from "./runtimeIssues";

const activity = (id: string, createdAt: string, message: string): OrchestrationThreadActivity =>
  ({
    id,
    kind: "runtime.error",
    createdAt,
    summary: message,
    payload: { message },
  }) as unknown as OrchestrationThreadActivity;

describe("runtime issues", () => {
  it("unwraps and explains NVIDIA overload JSON", () => {
    expect(
      normalizeRuntimeIssueMessage(
        '{"message":"Streaming response failed: [502] Upstream error from Nvidia: Service temporarily overloaded","type":"server_error"}',
      ),
    ).toBe(
      "NVIDIA is temporarily overloaded. T3 Studio retried once; try again shortly or switch models.",
    );
  });

  it("deduplicates repeated overloads and expires stale transient failures", () => {
    const now = Date.parse("2026-08-31T12:10:00.000Z");
    const recent = activity(
      "recent",
      "2026-08-31T12:08:00.000Z",
      '{"message":"[502] Upstream error from Nvidia: Service temporarily overloaded"}',
    );
    const duplicate = activity(
      "duplicate",
      "2026-08-31T12:07:00.000Z",
      "[502] Upstream error from Nvidia: Service temporarily overloaded",
    );
    const stale = activity(
      "stale",
      "2026-08-31T11:00:00.000Z",
      "[502] Upstream error from Nvidia: Service temporarily overloaded",
    );

    expect(deriveRuntimeStatusIssues([stale, duplicate, recent], now)).toHaveLength(1);
  });
});
