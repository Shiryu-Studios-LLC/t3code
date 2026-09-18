import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  bootstrapMissingProviderClis,
  resolveProviderBootstrapCommand,
} from "./providerBootstrap.ts";
import { makeProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCommandResult } from "./providerMaintenanceRunner.ts";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");
const OLLAMA = ProviderDriverKind.make("ollama");

const commandResult = (exitCode = 0): ProviderMaintenanceCommandResult => ({
  stdout: "",
  stderr: "",
  exitCode,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const missingProvider = (
  driver: ProviderDriverKind,
  instanceId = ProviderInstanceId.make(String(driver)),
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const installedProvider = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  installed: true,
  status: "ready",
});

describe("provider bootstrap", () => {
  it("builds a user-local npm install for package-managed Linux providers", () => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: CODEX,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global",
    });

    assert.deepStrictEqual(
      resolveProviderBootstrapCommand({
        provider: CODEX,
        maintenanceCapabilities: capabilities,
        environment: { HOME: "/home/test" },
        platform: "linux",
      }),
      {
        executable: "npm",
        args: [
          "install",
          "--global",
          "--prefix",
          "/home/test/.local",
          "--allow-scripts=@openai/codex",
          "@openai/codex@latest",
        ],
        fingerprint: "npm:@openai/codex:/home/test/.local",
      },
    );
  });

  it("uses Cursor's official Linux installer for the default agent binary", () => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: CURSOR,
      packageName: null,
      updateExecutable: "agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });

    assert.deepStrictEqual(
      resolveProviderBootstrapCommand({
        provider: CURSOR,
        maintenanceCapabilities: capabilities,
        environment: { HOME: "/home/test" },
        platform: "linux",
      }),
      {
        executable: "bash",
        args: ["-lc", "curl https://cursor.com/install -fsS | bash"],
        fingerprint: "cursor:official-installer",
      },
    );
  });

  it("builds Ollama's official Linux tar install into the user-local prefix", () => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: OLLAMA,
      packageName: null,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: "ollama",
    });

    assert.deepStrictEqual(
      resolveProviderBootstrapCommand({
        provider: OLLAMA,
        maintenanceCapabilities: capabilities,
        environment: { HOME: "/home/test" },
        platform: "linux",
      }),
      {
        executable: "bash",
        args: [
          "-lc",
          'set -e; mkdir -p "$HOME/.local"; curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | tar --zstd -x -C "$HOME/.local"',
        ],
        fingerprint: "ollama:official-linux-tar:user-local",
      },
    );
  });

  it("does not replace an explicitly configured Cursor binary", () => {
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: CURSOR,
      packageName: null,
      updateExecutable: "/opt/custom/cursor-agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });

    assert.isNull(
      resolveProviderBootstrapCommand({
        provider: CURSOR,
        maintenanceCapabilities: capabilities,
        environment: { HOME: "/home/test" },
        platform: "linux",
      }),
    );
  });

  it.effect("installs each shared missing CLI once and refreshes its provider snapshot", () =>
    Effect.gen(function* () {
      const first = missingProvider(CODEX, ProviderInstanceId.make("codex-personal"));
      const second = missingProvider(CODEX, ProviderInstanceId.make("codex-work"));
      const third = missingProvider(OPENCODE);
      const providers = [first, second, third];
      const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const refreshed = new Set<string>();
      const states: Array<{ instanceId: string; state: ServerProviderUpdateState | null }> = [];

      const capabilitiesFor = (driver: ProviderDriverKind) =>
        makeProviderMaintenanceCapabilities({
          provider: driver,
          packageName: driver === CODEX ? "@openai/codex" : "opencode-ai",
          updateExecutable: "npm",
          updateArgs: [
            "install",
            "-g",
            driver === CODEX ? "@openai/codex@latest" : "opencode-ai@latest",
          ],
          updateLockKey: "npm-global",
        });

      yield* bootstrapMissingProviderClis(
        {
          refreshProviders: () => Effect.succeed(providers),
          refreshInstance: (instanceId) =>
            Effect.sync(() => {
              refreshed.add(String(instanceId));
              return providers.map((provider) =>
                provider.driver === CODEX || provider.instanceId === instanceId
                  ? installedProvider(provider)
                  : provider,
              );
            }),
          getMaintenanceCapabilities: (_instanceId, driver) =>
            Effect.succeed(capabilitiesFor(driver)),
          setUpdateState: (instanceId, state) =>
            Effect.sync(() => {
              states.push({ instanceId: String(instanceId), state });
              return providers;
            }),
          runCommand: (command, args) =>
            Effect.sync(() => {
              commands.push({ command, args });
              return commandResult();
            }),
        },
        { environment: { HOME: "/home/test" }, platform: "linux" },
      );

      assert.strictEqual(commands.length, 2);
      assert.deepStrictEqual(
        commands.map((entry) => entry.args.at(-1)),
        ["@openai/codex@latest", "opencode-ai@latest"],
      );
      assert.isTrue(refreshed.has("codex-personal"));
      assert.isTrue(refreshed.has("codex-work"));
      assert.isTrue(refreshed.has("opencode"));
      assert.isTrue(states.some((entry) => entry.state?.status === "succeeded"));
    }),
  );
});
