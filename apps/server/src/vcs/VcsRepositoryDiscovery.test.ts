import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverRepositories } from "./VcsRepositoryDiscovery.ts";

it.layer(NodeServices.layer)("VcsRepositoryDiscovery", (it) => {
  it.effect("finds sibling repositories below a non-repository project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-nested-repos-" });
      const api = path.join(root, "apps", "api");
      const web = path.join(root, "apps", "web");
      yield* fs.makeDirectory(path.join(api, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(web, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "node_modules", "ignored", ".git"), {
        recursive: true,
      });

      const result = yield* discoverRepositories({ cwd: root });

      expect(result.repositories.map((repo) => repo.relativePath)).toEqual([
        path.join("apps", "api"),
        path.join("apps", "web"),
      ]);
    }),
  );

  it.effect("treats a repository root as the discovery boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-root-repo-" });
      yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "vendor", "nested", ".git"), { recursive: true });

      const result = yield* discoverRepositories({ cwd: root });

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]?.relativePath).toBe(".");
    }),
  );
});
