import { describe, expect, it } from "vite-plus/test";

import { buildPluginPromptContext } from "./PluginPromptContext.ts";

const servers = [
  {
    id: "gmail",
    name: "Gmail",
    enabled: true,
    transport: { type: "http" as const, url: "https://example.test/mcp", headers: [] },
  },
  {
    id: "slack",
    name: "Slack",
    enabled: false,
    transport: { type: "http" as const, url: "https://example.test/slack", headers: [] },
  },
];

describe("buildPluginPromptContext", () => {
  it("leaves ordinary prompts untouched", () => {
    const result = buildPluginPromptContext(
      "Refactor the audio meter component.",
      servers,
      "[Expanded skill instructions]\nRefactor the audio meter component.",
    );
    expect(result.activated).toBe(false);
    expect(result.prompt).toBe(
      "[Expanded skill instructions]\nRefactor the audio meter component.",
    );
  });

  it("activates for explicit plugin intent", () => {
    const result = buildPluginPromptContext(
      "Search my installed plugins for an email tool.",
      servers,
    );
    expect(result.activated).toBe(true);
    expect(result.reason).toBe("explicit");
    expect(result.prompt).toContain("[ShiryuGen tools]");
    expect(result.requiredCapabilities).toEqual(["email"]);
    expect(result.prompt).toContain("Matching enabled plugin: Gmail.");
    expect(result.prompt).not.toContain("Slack");
  });

  it("infers email capability from the task without requiring the word plugin", () => {
    const result = buildPluginPromptContext(
      "Send an email to Alex letting them know the build is ready.",
      servers,
    );
    expect(result.activated).toBe(true);
    expect(result.reason).toBe("capability");
    expect(result.requiredCapabilities).toEqual(["email"]);
    expect(result.matchedPluginNames).toEqual(["Gmail"]);
    expect(result.prompt).toContain("Likely capability: email.");
    expect(result.prompt).toContain("Matching enabled plugin: Gmail.");
  });

  it("routes image generation to T3's built-in local tool without cloud/API-key fallback", () => {
    const result = buildPluginPromptContext(
      "Generate an image of a futuristic fantasy academy at sunset.",
      servers,
    );
    expect(result.activated).toBe(true);
    expect(result.reason).toBe("capability");
    expect(result.requiredCapabilities).toEqual(["image-generation"]);
    expect(result.matchedPluginNames).toEqual([]);
    expect(result.prompt).toContain("image generation");
    expect(result.prompt).toContain("shiryugen_tool_search");
    expect(result.prompt).toContain("t3_generate_image");
  });

  it("infers common connected-app capabilities from natural requests", () => {
    expect(buildPluginPromptContext("Schedule a meeting tomorrow at 2 PM.", servers)).toMatchObject(
      {
        activated: true,
        requiredCapabilities: ["calendar"],
        reason: "capability",
      },
    );
    expect(buildPluginPromptContext("Post this update in Slack.", servers)).toMatchObject({
      activated: true,
      requiredCapabilities: ["messaging"],
      reason: "capability",
    });
    expect(
      buildPluginPromptContext("Find the budget file in Google Drive.", servers),
    ).toMatchObject({
      activated: true,
      requiredCapabilities: ["cloud-files"],
      reason: "capability",
    });
  });

  it("activates when an enabled plugin is named directly", () => {
    const result = buildPluginPromptContext("Use Gmail to send this draft.", servers);
    expect(result.activated).toBe(true);
    expect(result.matchedPluginNames).toEqual(["Gmail"]);
  });
});
