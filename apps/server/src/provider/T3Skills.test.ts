import { describe, expect, it } from "@effect/vitest";
import type { T3SkillConfig } from "@t3tools/contracts";

import { expandT3SkillsInPrompt } from "./T3Skills.ts";

const skills: T3SkillConfig[] = [
  {
    id: "stream-setup",
    name: "stream-setup",
    displayName: "Streaming Setup",
    description: "Prepare a streaming session.",
    instructions: "Check the mixer and OBS before starting the stream.",
    enabled: true,
  },
  {
    id: "disabled-skill",
    name: "disabled-skill",
    displayName: "Disabled Skill",
    description: "",
    instructions: "This should never be injected.",
    enabled: false,
  },
];

describe("expandT3SkillsInPrompt", () => {
  it("injects enabled T3 skill instructions while preserving the user request", () => {
    const result = expandT3SkillsInPrompt("Use $stream-setup and then go live.", skills);

    expect(result.activatedSkillNames).toEqual(["stream-setup"]);
    expect(result.prompt).toContain("### Streaming Setup");
    expect(result.prompt).toContain("Check the mixer and OBS before starting the stream.");
    expect(result.prompt).toContain("Use [Streaming Setup] and then go live.");
  });

  it("leaves provider-native or disabled skill tokens untouched", () => {
    expect(expandT3SkillsInPrompt("Use $provider-skill now.", skills)).toEqual({
      prompt: "Use $provider-skill now.",
      activatedSkillNames: [],
    });
    expect(expandT3SkillsInPrompt("Use $disabled-skill now.", skills)).toEqual({
      prompt: "Use $disabled-skill now.",
      activatedSkillNames: [],
    });
  });

  it("injects each referenced skill only once", () => {
    const result = expandT3SkillsInPrompt("$stream-setup then $stream-setup", skills);
    expect(result.activatedSkillNames).toEqual(["stream-setup"]);
    expect(result.prompt.match(/### Streaming Setup/g)).toHaveLength(1);
  });
});
