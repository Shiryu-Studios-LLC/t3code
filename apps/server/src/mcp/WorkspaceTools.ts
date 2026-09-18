// @effect-diagnostics nodeBuiltinImport:off - Workspace tools are an explicit Node process/filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BridgedMcpTool } from "./McpToolBridge.ts";

export const WORKSPACE_TOOLS: ReadonlyArray<BridgedMcpTool> = [
  {
    name: "execute_command",
    title: "Workspace: Execute Command",
    description:
      "Execute a shell command (e.g. bash, powershell, git, npm, python) in the workspace directory. Returns stdout, stderr, and exit status.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute in the workspace (e.g. 'pwd', 'ls -la', 'npm test', 'git status').",
        },
        cwd: {
          type: "string",
          description:
            "Optional relative subdirectory within the workspace to run the command in. Defaults to workspace root.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional maximum execution time in milliseconds (default 30000).",
        },
      },
      required: ["command"],
    },
    readOnly: false,
  },
  {
    name: "read_file",
    title: "Workspace: Read File",
    description:
      "Read the text content of a file in the workspace. Returns line-numbered file content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path of the file to read.",
        },
        startLine: {
          type: "number",
          description: "Optional 1-indexed line number to start reading from (defaults to 1).",
        },
        lineCount: {
          type: "number",
          description: "Optional number of lines to read.",
        },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  {
    name: "write_file",
    title: "Workspace: Write File",
    description:
      "Create a new file or overwrite an existing file with new content in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path of the file to create or overwrite.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
    readOnly: false,
  },
  {
    name: "edit_file",
    title: "Workspace: Edit File",
    description:
      "Replace target text in a file with replacement text. The targetContent must uniquely match within the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path of the file to edit.",
        },
        targetContent: {
          type: "string",
          description: "The exact character-for-character string in the file to replace.",
        },
        replacementContent: {
          type: "string",
          description: "The new replacement string.",
        },
      },
      required: ["path", "targetContent", "replacementContent"],
    },
    readOnly: false,
  },
  {
    name: "list_directory",
    title: "Workspace: List Directory",
    description: "List files and folders in a workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative or absolute path of the directory to list (defaults to workspace root '.').",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list subdirectories recursively (default false).",
        },
        maxDepth: {
          type: "number",
          description: "Maximum directory recursion depth (default 2, max 5).",
        },
      },
    },
    readOnly: true,
  },
  {
    name: "grep_search",
    title: "Workspace: Grep Search",
    description: "Search for text matches or regular expressions across files in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text string or regex pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional relative directory to search within (defaults to workspace root).",
        },
        filePattern: {
          type: "string",
          description:
            "Optional file name pattern or extension filter (e.g. '.ts', 'package.json').",
        },
      },
      required: ["query"],
    },
    readOnly: true,
  },
];

const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOLS.map((tool) => tool.name));

function resolveWorkspacePath(baseCwd: string, requestedPath: string): string {
  const resolved = NodePath.resolve(baseCwd, requestedPath);
  const relative = NodePath.relative(baseCwd, resolved);
  if (relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Path must stay within the workspace: ${requestedPath}`);
}

export function isWorkspaceTool(name: string): boolean {
  return WORKSPACE_TOOL_NAMES.has(name);
}

export async function executeWorkspaceTool(
  name: string,
  input: unknown,
  baseCwd: string = process.cwd(),
): Promise<string> {
  const safeBaseCwd = baseCwd && NodeFS.existsSync(baseCwd) ? baseCwd : process.cwd();

  switch (name) {
    case "execute_command": {
      const params = (input && typeof input === "object" ? input : {}) as {
        command?: string;
        cwd?: string;
        timeoutMs?: number;
      };
      const command = params.command?.trim();
      if (!command) {
        throw new Error("Missing required 'command' argument.");
      }
      const effectiveCwd = params.cwd ? resolveWorkspacePath(safeBaseCwd, params.cwd) : safeBaseCwd;
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30000, 1000), 120000);

      return new Promise((resolve) => {
        NodeChildProcess.exec(
          command,
          {
            cwd: effectiveCwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const outStr = (stdout || "").trim();
            const errStr = (stderr || "").trim();
            if (error) {
              const exitCode = error.code ?? 1;
              const pieces = [
                `Command exited with code ${exitCode}.`,
                outStr ? `stdout:\n${outStr}` : "",
                errStr ? `stderr:\n${errStr}` : "",
                `error: ${error.message}`,
              ].filter(Boolean);
              resolve(pieces.join("\n\n"));
            } else {
              if (outStr.length === 0 && errStr.length === 0) {
                resolve("Command executed successfully (no output).");
              } else {
                resolve([outStr, errStr ? `stderr:\n${errStr}` : ""].filter(Boolean).join("\n\n"));
              }
            }
          },
        );
      });
    }

    case "read_file": {
      const params = (input && typeof input === "object" ? input : {}) as {
        path?: string;
        startLine?: number;
        lineCount?: number;
      };
      const rawPath = params.path?.trim();
      if (!rawPath) {
        throw new Error("Missing required 'path' argument.");
      }
      const fullPath = resolveWorkspacePath(safeBaseCwd, rawPath);
      if (!NodeFS.existsSync(fullPath)) {
        throw new Error(`File not found: ${rawPath}`);
      }
      const stat = await NodeFS.promises.stat(fullPath);
      if (stat.isDirectory()) {
        throw new Error(
          `Path is a directory: ${rawPath}. Use list_directory to inspect directories.`,
        );
      }
      const content = await NodeFS.promises.readFile(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(1, params.startLine ?? 1);
      const lineCount = params.lineCount ? Math.max(1, params.lineCount) : lines.length;
      const slice = lines.slice(startLine - 1, startLine - 1 + lineCount);
      return slice.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");
    }

    case "write_file": {
      const params = (input && typeof input === "object" ? input : {}) as {
        path?: string;
        content?: string;
      };
      const rawPath = params.path?.trim();
      if (!rawPath) {
        throw new Error("Missing required 'path' argument.");
      }
      if (typeof params.content !== "string") {
        throw new Error("Missing required 'content' argument.");
      }
      const fullPath = resolveWorkspacePath(safeBaseCwd, rawPath);
      await NodeFS.promises.mkdir(NodePath.dirname(fullPath), { recursive: true });
      await NodeFS.promises.writeFile(fullPath, params.content, "utf-8");
      return `Successfully wrote ${Buffer.byteLength(params.content, "utf-8")} bytes to ${rawPath}.`;
    }

    case "edit_file": {
      const params = (input && typeof input === "object" ? input : {}) as {
        path?: string;
        targetContent?: string;
        replacementContent?: string;
      };
      const rawPath = params.path?.trim();
      if (!rawPath) throw new Error("Missing required 'path' argument.");
      if (typeof params.targetContent !== "string")
        throw new Error("Missing required 'targetContent' argument.");
      if (typeof params.replacementContent !== "string")
        throw new Error("Missing required 'replacementContent' argument.");

      const fullPath = resolveWorkspacePath(safeBaseCwd, rawPath);
      if (!NodeFS.existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);

      const content = await NodeFS.promises.readFile(fullPath, "utf-8");
      if (!content.includes(params.targetContent)) {
        throw new Error(
          `Target content not found in ${rawPath}. Ensure exact character/newline match.`,
        );
      }
      const occurrences = content.split(params.targetContent).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Target content matched ${occurrences} times in ${rawPath}. Include more surrounding lines to create a unique match.`,
        );
      }
      const updated = content.replace(params.targetContent, params.replacementContent);
      await NodeFS.promises.writeFile(fullPath, updated, "utf-8");
      return `Successfully replaced target content in ${rawPath}.`;
    }

    case "list_directory": {
      const params = (input && typeof input === "object" ? input : {}) as {
        path?: string;
        recursive?: boolean;
        maxDepth?: number;
      };
      const rawPath = params.path?.trim() || ".";
      const fullPath = resolveWorkspacePath(safeBaseCwd, rawPath);
      if (!NodeFS.existsSync(fullPath)) throw new Error(`Directory not found: ${rawPath}`);

      const isRecursive = params.recursive === true;
      const maxDepth = Math.min(Math.max(params.maxDepth ?? 2, 1), 5);
      const results: string[] = [];

      async function scan(dir: string, currentDepth: number) {
        const entries = await NodeFS.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const relPath = NodePath.relative(safeBaseCwd, NodePath.join(dir, entry.name)).replace(
            /\\/g,
            "/",
          );
          if (entry.isDirectory()) {
            results.push(`[DIR]  ${relPath}/`);
            if (isRecursive && currentDepth < maxDepth) {
              await scan(NodePath.join(dir, entry.name), currentDepth + 1);
            }
          } else {
            results.push(`[FILE] ${relPath}`);
          }
          if (results.length >= 500) {
            results.push("... (truncated at 500 entries)");
            return;
          }
        }
      }

      await scan(fullPath, 1);
      return results.length > 0 ? results.join("\n") : "Directory is empty.";
    }

    case "grep_search": {
      const params = (input && typeof input === "object" ? input : {}) as {
        query?: string;
        path?: string;
        filePattern?: string;
      };
      const query = params.query?.trim();
      if (!query) throw new Error("Missing required 'query' argument.");

      const startDir = params.path ? resolveWorkspacePath(safeBaseCwd, params.path) : safeBaseCwd;
      if (!NodeFS.existsSync(startDir)) throw new Error(`Search path not found: ${params.path}`);

      const results: string[] = [];
      let regex: RegExp;
      try {
        regex = new RegExp(query, "i");
      } catch {
        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }

      async function walk(dir: string) {
        if (results.length >= 100) return;
        const entries = await NodeFS.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === ".git" ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === ".turbo" ||
            entry.name === "build"
          ) {
            continue;
          }
          const full = NodePath.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            if (params.filePattern && !entry.name.includes(params.filePattern.replace(/^\*/, ""))) {
              continue;
            }
            try {
              const content = await NodeFS.promises.readFile(full, "utf-8");
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]!)) {
                  const rel = NodePath.relative(safeBaseCwd, full).replace(/\\/g, "/");
                  results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
                  if (results.length >= 100) {
                    results.push("... (truncated at 100 matches)");
                    return;
                  }
                }
              }
            } catch {}
          }
        }
      }

      await walk(startDir);
      return results.length > 0 ? results.join("\n") : `No matches found for "${query}".`;
    }

    default:
      throw new Error(`Unknown workspace tool '${name}'.`);
  }
}
