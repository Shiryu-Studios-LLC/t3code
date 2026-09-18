import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderSkill, T3SkillConfig } from "@t3tools/contracts";

import { mergeT3SkillsWithProviderSkills, t3SkillAsProviderSkill } from "./t3Skills";

const custom: T3SkillConfig = {
  id: "streaming",
  name: "streaming",
  displayName: "Streaming Setup",
  description: "Prepare the stream.",
  instructions: "Verify audio and video before going live.",
  enabled: true,
};

describe("t3Skills", () => {
  it("projects T3 skills into the existing composer skill shape", () => {
    expect(t3SkillAsProviderSkill(custom)).toEqual({
      name: "streaming",
      displayName: "Streaming Setup",
      description: "Prepare the stream.",
      shortDescription: "Prepare the stream.",
      path: "t3://skills/streaming",
      scope: "app",
      enabled: true,
    });
  });

  it("keeps provider-native skills authoritative on name collisions", () => {
    const native: ServerProviderSkill = {
      name: "streaming",
      displayName: "Provider Streaming",
      path: "/skills/streaming/SKILL.md",
      enabled: true,
    };
    expect(mergeT3SkillsWithProviderSkills([native], [custom])).toEqual([native]);
  });
});
