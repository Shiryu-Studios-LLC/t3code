import { describe, expect, it } from "vite-plus/test";

import { prepareTextForSpeech, splitSpeechText } from "./speechText";

describe("prepareTextForSpeech", () => {
  it("turns markdown into natural speech text", () => {
    expect(
      prepareTextForSpeech(
        "# Result\n\n- Read the [documentation](https://example.com).\n- Visit https://example.com/path.",
      ),
    ).toBe("Result Read the documentation. Visit a link");
  });

  it("summarizes fenced code instead of reading it literally", () => {
    expect(
      prepareTextForSpeech("Use this:\n```ts\nconst one = 1;\nconst two = 2;\n```\nDone."),
    ).toBe("Use this: A TypeScript code example with 2 lines is included. Done.");
  });
});

describe("splitSpeechText", () => {
  it("keeps short text in one chunk", () => {
    expect(splitSpeechText("Short response.", 100)).toEqual(["Short response."]);
  });

  it("splits long speech into bounded chunks", () => {
    const chunks = splitSpeechText("First sentence. Second sentence. Third sentence.", 24);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(chunks.join(" ")).toContain("First sentence.");
    expect(chunks.join(" ")).toContain("Third sentence.");
  });
});
