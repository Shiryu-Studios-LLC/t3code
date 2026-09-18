import { afterEach, describe, expect, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "~/hooks/useSettings";
import { shouldAutoReadAssistantMessage } from "./ttsController";

afterEach(() => {
  __resetClientSettingsPersistenceForTests();
});

describe("shouldAutoReadAssistantMessage", () => {
  it("fires when a newly observed assistant message becomes settled", () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      textToSpeechEnabled: true,
      textToSpeechAutoRead: true,
    });

    expect(shouldAutoReadAssistantMessage("assistant-new", false)).toBe(false);
    expect(shouldAutoReadAssistantMessage("assistant-new", true)).toBe(true);
    expect(shouldAutoReadAssistantMessage("assistant-new", true)).toBe(false);
  });

  it("does not replay an already-settled historical message", () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      textToSpeechEnabled: true,
      textToSpeechAutoRead: true,
    });

    expect(shouldAutoReadAssistantMessage("assistant-history", true)).toBe(false);
  });

  it("respects the automatic text-to-speech toggle", () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      textToSpeechEnabled: true,
      textToSpeechAutoRead: false,
    });

    expect(shouldAutoReadAssistantMessage("assistant-disabled", false)).toBe(false);
    expect(shouldAutoReadAssistantMessage("assistant-disabled", true)).toBe(false);
  });
});
