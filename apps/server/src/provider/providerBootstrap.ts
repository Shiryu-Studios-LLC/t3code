import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import type {
  ProviderMaintenanceCommandError,
  ProviderMaintenanceCommandResult,
} from "./providerMaintenanceRunner.ts";

const CLI_BACKED_PROVIDERS = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("grok"),
  ProviderDriverKind.make("opencode"),
  ProviderDriverKind.make("ollama"),
]);

const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OLLAMA_DRIVER = ProviderDriverKind.make("ollama");
const CURSOR_DEFAULT_BINARIES = new Set(["agent", "cursor-agent"]);
const MAX_BOOTSTRAP_OUTPUT_LENGTH = 10_000;

export interface ProviderBootstrapCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly fingerprint: string;
}

export interface ProviderBootstrapRuntime {
  readonly refreshProviders: () => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly getMaintenanceCapabilities: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly setUpdateState: (
    instanceId: ProviderInstanceId,
    state: ServerProviderUpdateState | null,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly runCommand: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ProviderMaintenanceCommandResult, ProviderMaintenanceCommandError>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function makeNpmUserInstallCommand(packageName: string, home: string): ProviderBootstrapCommand {
  const prefix = `${trimTrailingSlash(home)}/.local`;
  const args = [
    "install",
    "--global",
    "--prefix",
    prefix,
    `--allow-scripts=${packageName}`,
    `${packageName}@latest`,
  ] as const;
  return {
    executable: "npm",
    args,
    fingerprint: `npm:${packageName}:${prefix}`,
  };
}

export function resolveProviderBootstrapCommand(input: {
  readonly provider: ProviderDriverKind;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): ProviderBootstrapCommand | null {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") {
    return null;
  }

  const environment = input.environment ?? process.env;
  const home = environment.HOME?.trim();
  if (!home) {
    return null;
  }

  if (input.provider === OLLAMA_DRIVER) {
    const configuredUpdateExecutable = input.maintenanceCapabilities.update?.executable.trim();
    if (configuredUpdateExecutable && configuredUpdateExecutable !== "ollama") {
      return null;
    }
    const installScript =
      'set -e; mkdir -p "$HOME/.local"; curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | tar --zstd -x -C "$HOME/.local"';
    return {
      executable: "bash",
      args: ["-lc", installScript],
      fingerprint: "ollama:official-linux-tar:user-local",
    };
  }

  if (input.provider === CURSOR_DRIVER) {
    const configuredUpdateExecutable = input.maintenanceCapabilities.update?.executable.trim();
    if (configuredUpdateExecutable && !CURSOR_DEFAULT_BINARIES.has(configuredUpdateExecutable)) {
      return null;
    }
    const installScript = "curl https://cursor.com/install -fsS | bash";
    return {
      executable: "bash",
      args: ["-lc", installScript],
      fingerprint: "cursor:official-installer",
    };
  }

  const packageName = input.maintenanceCapabilities.packageName?.trim();
  if (!packageName || input.maintenanceCapabilities.update === null) {
    return null;
  }
  return makeNpmUserInstallCommand(packageName, home);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = [result.stderr, result.stdout]
    .filter((value) => value.trim().length > 0)
    .join("\n\n")
    .trim();
  if (!output) {
    return null;
  }
  return output.slice(0, MAX_BOOTSTRAP_OUTPUT_LENGTH);
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

function shouldBootstrapProvider(provider: ServerProvider): boolean {
  return (
    CLI_BACKED_PROVIDERS.has(provider.driver) &&
    provider.enabled &&
    provider.availability !== "unavailable" &&
    !provider.installed
  );
}

export const bootstrapMissingProviderClis = Effect.fn("bootstrapMissingProviderClis")(
  function* (
    runtime: ProviderBootstrapRuntime,
    options?: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly platform?: NodeJS.Platform;
    },
  ) {
    const platform = options?.platform ?? process.platform;
    if (platform !== "linux") {
      return;
    }

    const providers = yield* runtime.refreshProviders();
    const attemptedCommands = new Set<string>();

    for (const provider of providers) {
      if (!shouldBootstrapProvider(provider)) {
        continue;
      }

      const capabilities = yield* runtime.getMaintenanceCapabilities(
        provider.instanceId,
        provider.driver,
      );
      const command = resolveProviderBootstrapCommand({
        provider: provider.driver,
        maintenanceCapabilities: capabilities,
        ...(options?.environment ? { environment: options.environment } : {}),
        platform,
      });
      if (!command) {
        continue;
      }

      if (attemptedCommands.has(command.fingerprint)) {
        yield* runtime.refreshInstance(provider.instanceId);
        continue;
      }
      attemptedCommands.add(command.fingerprint);

      const startedAt = DateTime.formatIso(yield* DateTime.now);
      yield* runtime.setUpdateState(
        provider.instanceId,
        makeUpdateState({
          status: "running",
          startedAt,
          finishedAt: null,
          message: "Installing missing provider CLI automatically.",
        }),
      );

      const commandResult = yield* runtime
        .runCommand(command.executable, command.args)
        .pipe(Effect.result);
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      if (Result.isFailure(commandResult)) {
        yield* runtime.setUpdateState(
          provider.instanceId,
          makeUpdateState({
            status: "failed",
            startedAt,
            finishedAt,
            message: "Automatic provider installation could not be started.",
          }),
        );
        continue;
      }
      const result = commandResult.success;
      if (result.timedOut || result.exitCode !== 0) {
        yield* runtime.setUpdateState(
          provider.instanceId,
          makeUpdateState({
            status: "failed",
            startedAt,
            finishedAt,
            message: result.timedOut
              ? "Automatic provider installation timed out."
              : `Automatic provider installation exited with code ${String(result.exitCode)}.`,
            output: commandOutput(result),
          }),
        );
        continue;
      }

      const refreshedProviders = yield* runtime.refreshInstance(provider.instanceId);
      const refreshedProvider = refreshedProviders.find(
        (candidate) => candidate.instanceId === provider.instanceId,
      );
      const installed = refreshedProvider?.installed === true;
      yield* runtime.setUpdateState(
        provider.instanceId,
        makeUpdateState({
          status: installed ? "succeeded" : "failed",
          startedAt,
          finishedAt,
          message: installed
            ? "Provider CLI installed automatically."
            : "Install command completed, but the provider CLI is still unavailable.",
          output: commandOutput(result),
        }),
      );
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Automatic provider CLI bootstrap failed", { cause }).pipe(Effect.asVoid),
  ),
);
