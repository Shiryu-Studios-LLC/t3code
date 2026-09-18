import { describe, expect, it } from "vite-plus/test";

import {
  ensureLinuxProviderUserBins,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        "darwin",
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("prepends Linux user-local provider bins so service launches can find installed CLIs", () => {
    expect(
      ensureLinuxProviderUserBins({ HOME: "/home/test", PATH: "/usr/local/bin:/usr/bin" }, "linux")
        .PATH,
    ).toBe(
      "/home/test/.local/bin:/home/test/.grok/bin:/home/test/.opencode/bin:/usr/local/bin:/usr/bin",
    );
  });

  it("uses provider-specific HOME and PATH overrides before adding Linux provider bins", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "HOME", value: "/srv/provider", sensitive: false },
          { name: "PATH", value: "/opt/provider/bin:/usr/bin", sensitive: false },
        ],
        { HOME: "/home/test", PATH: "/bin" },
        "linux",
      ).PATH,
    ).toBe(
      "/srv/provider/.local/bin:/srv/provider/.grok/bin:/srv/provider/.opencode/bin:/opt/provider/bin:/usr/bin",
    );
  });

  it("does not duplicate Linux user-local provider bins already on PATH", () => {
    expect(
      ensureLinuxProviderUserBins(
        {
          HOME: "/home/test",
          PATH: "/home/test/.local/bin:/home/test/.grok/bin:/home/test/.opencode/bin:/usr/bin",
        },
        "linux",
      ).PATH,
    ).toBe("/home/test/.local/bin:/home/test/.grok/bin:/home/test/.opencode/bin:/usr/bin");
  });
});
