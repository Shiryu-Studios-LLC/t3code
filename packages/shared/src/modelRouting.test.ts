import { describe, expect, it } from "@effect/vitest";
import {
  calculateModelRankScore,
  isCostPolicyAllowed,
  modelSatisfiesCapabilities,
  ROLE_DEFAULT_CAPABILITIES,
  ROLE_PRESENTATION,
} from "./modelRouting.ts";

describe("shared modelRouting", () => {
  it("provides default capabilities and presentations for all roles", () => {
    expect(ROLE_DEFAULT_CAPABILITIES.orchestrator).toContain("reasoning");
    expect(ROLE_DEFAULT_CAPABILITIES.coder).toContain("coding");
    expect(ROLE_DEFAULT_CAPABILITIES.vision).toContain("vision_input");
    expect(ROLE_DEFAULT_CAPABILITIES.image_generator).toContain("image_generation");
    expect(ROLE_PRESENTATION.orchestrator.emoji).toBe("🧠");
    expect(ROLE_PRESENTATION.coder.emoji).toBe("💻");
  });

  it("checks capability satisfaction accurately", () => {
    const geminiCaps = {
      tags: ["reasoning", "coding", "vision_input", "tool_calling", "large_context"] as const,
      free: true,
      contextWindow: 1_000_000,
    };

    expect(modelSatisfiesCapabilities(geminiCaps, ["reasoning", "coding"])).toBe(true);
    expect(modelSatisfiesCapabilities(geminiCaps, ["vision_input"])).toBe(true);
    expect(modelSatisfiesCapabilities(geminiCaps, ["image_generation"])).toBe(false);
  });

  it("enforces cost policy rules", () => {
    expect(isCostPolicyAllowed("free", true, "free_only")).toBe(true);
    expect(isCostPolicyAllowed("premium", false, "free_only")).toBe(false);
    expect(isCostPolicyAllowed("premium", false, "prefer_free")).toBe(true);
    expect(isCostPolicyAllowed("premium", false, "unrestricted")).toBe(true);
  });

  it("ranks free models higher when prefer_free is set", () => {
    const freeScore = calculateModelRankScore({
      capabilities: { free: true, costTier: "free" },
      required: ["coding"],
      costPolicy: "prefer_free",
    });

    const paidScore = calculateModelRankScore({
      capabilities: { free: false, costTier: "standard" },
      required: ["coding"],
      costPolicy: "prefer_free",
    });

    expect(freeScore).toBeGreaterThan(paidScore);
  });
});
