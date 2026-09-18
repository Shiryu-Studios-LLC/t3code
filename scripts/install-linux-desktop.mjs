#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const artifactDir = path.resolve(repoRoot, process.argv[2] ?? "release/local");

async function newestAppImage(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".AppImage"))
      .map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        const stat = await fs.stat(fullPath);
        return { fullPath, name: entry.name, mtimeMs: stat.mtimeMs };
      }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`No AppImage found in ${directory}`);
  }
  return candidates[0];
}

async function copyReflinkFriendly(source, destination) {
  try {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
  } catch {
    await fs.copyFile(source, destination);
  }
  await fs.chmod(destination, 0o755);
}

async function atomicSymlink(target, linkPath) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const tempLink = `${linkPath}.new-${process.pid}`;
  await fs.rm(tempLink, { force: true });
  await fs.symlink(target, tempLink);
  await fs.rename(tempLink, linkPath);
}

function refreshDesktopDatabase(applicationsDir) {
  for (const [command, args] of [
    ["update-desktop-database", [applicationsDir]],
    ["kbuildsycoca6", ["--noincremental"]],
  ]) {
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.error?.code !== "ENOENT" && result.status !== 0 && result.status !== null) {
      console.warn(`[linux-install] ${command} exited with status ${result.status}`);
    }
  }
}

const artifact = await newestAppImage(artifactDir);
const home = os.homedir();
const buildsDir = path.join(home, ".local", "share", "t3-studio", "builds");
const binPath = path.join(home, ".local", "bin", "t3-studio");
const applicationsDir = path.join(home, ".local", "share", "applications");
const buildId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const installedAppImage = path.join(buildsDir, `${buildId}-${artifact.name}`);

await fs.mkdir(buildsDir, { recursive: true });
await fs.mkdir(applicationsDir, { recursive: true });
await copyReflinkFriendly(artifact.fullPath, installedAppImage);
await atomicSymlink(installedAppImage, binPath);

const iconPath = path.join(repoRoot, "assets", "prod", "shiryu-studio.svg");
const execPath = binPath.replaceAll("%", "%%");
const desktopEntry = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=ShiryuGen\nComment=ShiryuGen local AI creation studio\nExec=${execPath} %U\nTryExec=${execPath}\nIcon=${iconPath}\nTerminal=false\nCategories=Development;IDE;\nStartupNotify=true\nMimeType=x-scheme-handler/t3code;\n`;
const urlHandlerEntry = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=ShiryuGen\nExec=${execPath} %U\nTryExec=${execPath}\nIcon=${iconPath}\nTerminal=false\nNoDisplay=true\nStartupNotify=false\nMimeType=x-scheme-handler/t3code;\n`;

await fs.writeFile(path.join(applicationsDir, "t3-studio.desktop"), desktopEntry, "utf8");
await fs.writeFile(
  path.join(applicationsDir, "t3code-url-handler.desktop"),
  urlHandlerEntry,
  "utf8",
);
// Preserve login startup when upgrading an existing installation.
const autostartPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
  "autostart",
  "t3-studio.desktop",
);
try {
  const startupEntry = await fs.readFile(autostartPath, "utf8");
  await fs.writeFile(
    autostartPath,
    startupEntry
      .replace(/^Name=.*$/m, "Name=ShiryuGen")
      .replace(/^Comment=.*$/m, "Comment=ShiryuGen local AI creation studio")
      .replace(/^Exec=.*$/m, `Exec=${execPath} --hidden`)
      .replace(/^Icon=.*$/m, `Icon=${iconPath}`)
      .replace("StartupNotify=true", "StartupNotify=false"),
    "utf8",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

refreshDesktopDatabase(applicationsDir);

console.log(`[linux-install] Installed ${artifact.name}`);
console.log(`[linux-install] Current launcher target: ${binPath} -> ${installedAppImage}`);
