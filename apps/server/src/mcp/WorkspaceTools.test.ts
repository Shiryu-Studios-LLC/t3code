// @effect-diagnostics nodeBuiltinImport:off - Test fixtures exercise the Node workspace boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { executeWorkspaceTool } from "./WorkspaceTools.ts";

describe("workspace tools", () => {
  it("reads files inside the workspace", async () => {
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workspace-tools-"));
    try {
      NodeFS.writeFileSync(NodePath.join(workspace, "hello.txt"), "hello\nworld", "utf8");

      await expect(
        executeWorkspaceTool("read_file", { path: "hello.txt" }, workspace),
      ).resolves.toBe("1: hello\n2: world");
    } finally {
      NodeFS.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects file paths outside the workspace", async () => {
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workspace-tools-"));
    try {
      await expect(
        executeWorkspaceTool("read_file", { path: "../outside.txt" }, workspace),
      ).rejects.toThrow("Path must stay within the workspace");
    } finally {
      NodeFS.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects command working directories outside the workspace", async () => {
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-workspace-tools-"));
    try {
      await expect(
        executeWorkspaceTool("execute_command", { command: "echo safe", cwd: ".." }, workspace),
      ).rejects.toThrow("Path must stay within the workspace");
    } finally {
      NodeFS.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
