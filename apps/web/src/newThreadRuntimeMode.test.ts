import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadRuntimeMode } from "./newThreadRuntimeMode";

describe("resolveNewThreadRuntimeMode", () => {
  it("defaults new conversations to Full access", () => {
    expect(resolveNewThreadRuntimeMode()).toBe("full-access");
  });

  it("preserves an explicit caller override", () => {
    expect(resolveNewThreadRuntimeMode("approval-required")).toBe("approval-required");
    expect(resolveNewThreadRuntimeMode("auto-accept-edits")).toBe("auto-accept-edits");
  });
});
