import type {
  VcsDiscoverRepositoriesInput,
  VcsDiscoverRepositoriesResult,
  VcsDiscoveredRepository,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const DEFAULT_MAX_DEPTH = 6;
const MAX_REPOSITORIES = 64;
const DISCOVERY_TIME_BUDGET_MS = 8_000;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".t3",
  ".cache",
  ".next",
  ".nuxt",
  ".venv",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "bin",
  "obj",
  "Binaries",
  "Intermediate",
  "Library",
  "Saved",
  "Temp",
]);

export const discoverRepositories = Effect.fn("VcsRepositoryDiscovery.discover")(function* (
  input: VcsDiscoverRepositoriesInput,
): Effect.fn.Return<VcsDiscoverRepositoriesResult, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const statOptional = (targetPath: string) => fs.stat(targetPath).pipe(Effect.option);

  const hasGitMetadata = Effect.fn("VcsRepositoryDiscovery.hasGitMetadata")(function* (
    directory: string,
  ) {
    const info = yield* statOptional(path.join(directory, ".git"));
    if (Option.isNone(info)) return false;
    return info.value.type === "Directory" || info.value.type === "File";
  });

  const resolvedRoot = yield* fs
    .realPath(input.cwd)
    .pipe(Effect.orElseSucceed(() => path.resolve(input.cwd)));
  const repositories: VcsDiscoveredRepository[] = [];

  const addRepository = (rootPath: string) => {
    const relative = path.relative(resolvedRoot, rootPath);
    repositories.push({
      rootPath,
      relativePath: relative.length === 0 ? "." : relative,
      name: path.basename(rootPath) || rootPath,
    });
  };

  const walk = (directory: string, depth: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (repositories.length >= MAX_REPOSITORIES) return;

      if (yield* hasGitMetadata(directory)) {
        addRepository(directory);
        // Treat a repository as a boundary. Submodules and vendored nested
        // repositories can still be opened as their own T3 projects, while
        // this project-level selector stays focused on sibling repositories.
        return;
      }

      if (depth >= DEFAULT_MAX_DEPTH) return;

      const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      const childDirectories = yield* Effect.forEach(
        entries.filter((entry) => !entry.startsWith(".") && !SKIPPED_DIRECTORY_NAMES.has(entry)),
        (entry) => {
          const child = path.join(directory, entry);
          return statOptional(child).pipe(
            Effect.map((info) =>
              Option.isSome(info) && info.value.type === "Directory" ? child : null,
            ),
          );
        },
        { concurrency: 8 },
      ).pipe(Effect.map((children) => children.filter((child): child is string => child !== null)));

      childDirectories.sort((left, right) => left.localeCompare(right));
      yield* Effect.forEach(childDirectories, (child) => walk(child, depth + 1), {
        concurrency: 4,
        discard: true,
      });
    });

  // Repository discovery is automatic navigation metadata, not a blocking
  // project operation. Return the useful partial set instead of allowing a
  // network drive or enormous monorepo to hold the RPC open indefinitely.
  yield* walk(resolvedRoot, 0).pipe(Effect.timeoutOption(DISCOVERY_TIME_BUDGET_MS));
  repositories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { repositories };
});
