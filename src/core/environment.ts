import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import * as TOML from "@iarna/toml";
import type { Ecosystem } from "./model.js";
import {
  copyDirectory,
  fileExists,
  readJsonFile,
  readTextFile,
  removeDirectory,
  writeJsonFile,
  writeTextFile,
} from "../util/fs.js";
import { runCommand, type ExecResult } from "../util/exec.js";
import { logger } from "../util/logger.js";

export interface IsolatedEnvironment {
  dir: string;
  ecosystem: Ecosystem;
  patchManifest(targetPackage: string, targetVersion: string): Promise<boolean>;
  install(options?: { timeoutMs?: number }): Promise<ExecResult>;
  cleanup(): Promise<void>;
}

const activeSandboxes = new Set<string>();

let exitHooksRegistered = false;
function registerExitHooks() {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;

  const purgeAll = () => {
    for (const dir of activeSandboxes) {
      try {
        // Sync remove if process is exiting
        import("node:fs").then((fs) => {
          fs.rmSync(dir, { recursive: true, force: true });
        }).catch(() => {});
      } catch {
        // ignore
      }
    }
  };

  process.on("exit", purgeAll);
  process.on("SIGINT", () => {
    purgeAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    purgeAll();
    process.exit(143);
  });
}

export async function createIsolatedEnvironment(
  repoRoot: string,
  ecosystem: Ecosystem,
): Promise<IsolatedEnvironment> {
  registerExitHooks();
  const tmpPrefix = path.join(os.tmpdir(), "deprisk-sandbox-");
  const sandboxDir = await mkdtemp(tmpPrefix);
  activeSandboxes.add(sandboxDir);
  logger.debug("sandbox", `Created sandbox at ${sandboxDir} for ${repoRoot}`);

  await copyDirectory(repoRoot, sandboxDir);

  const patchManifest = async (targetPackage: string, targetVersion: string): Promise<boolean> => {
    if (ecosystem === "node") {
      const pkg = await readJsonFile<Record<string, any>>(sandboxDir, "package.json");
      if (!pkg) return false;

      let found = false;
      if (pkg.dependencies && targetPackage in pkg.dependencies) {
        pkg.dependencies[targetPackage] = targetVersion;
        found = true;
      }
      if (pkg.devDependencies && targetPackage in pkg.devDependencies) {
        pkg.devDependencies[targetPackage] = targetVersion;
        found = true;
      }
      if (!found) {
        if (!pkg.dependencies) pkg.dependencies = {};
        pkg.dependencies[targetPackage] = targetVersion;
      }

      await writeJsonFile(sandboxDir, "package.json", pkg);
      logger.debug("sandbox", `Patched package.json with ${targetPackage}@${targetVersion}`);
      return true;
    }

    if (ecosystem === "python") {
      const hasPyproject = await fileExists(sandboxDir, "pyproject.toml");
      if (hasPyproject) {
        const text = await readTextFile(sandboxDir, "pyproject.toml");
        if (text) {
          try {
            const doc = TOML.parse(text) as any;
            if (doc.project?.dependencies && Array.isArray(doc.project.dependencies)) {
              const deps = doc.project.dependencies as string[];
              const idx = deps.findIndex((d) => d.toLowerCase().startsWith(targetPackage.toLowerCase()));
              const newSpec = `${targetPackage}==${targetVersion}`;
              if (idx !== -1) {
                deps[idx] = newSpec;
              } else {
                deps.push(newSpec);
              }
              await writeTextFile(sandboxDir, "pyproject.toml", TOML.stringify(doc));
              return true;
            }
          } catch {
            // fall back to line replacement
          }
        }
      }

      const hasReqs = await fileExists(sandboxDir, "requirements.txt");
      if (hasReqs) {
        const text = await readTextFile(sandboxDir, "requirements.txt");
        if (text !== null) {
          const lines = text.split("\n");
          let replaced = false;
          const updated = lines.map((line) => {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith(targetPackage.toLowerCase())) {
              replaced = true;
              return `${targetPackage}==${targetVersion}`;
            }
            return line;
          });
          if (!replaced) {
            updated.push(`${targetPackage}==${targetVersion}`);
          }
          await writeTextFile(sandboxDir, "requirements.txt", updated.join("\n"));
          return true;
        }
      }
    }

    return false;
  };

  const install = async (options: { timeoutMs?: number } = {}): Promise<ExecResult> => {
    if (ecosystem === "node") {
      // Use npm install inside sandbox
      return runCommand("npm install --no-audit --no-fund", {
        cwd: sandboxDir,
        timeoutMs: options.timeoutMs ?? 120_000,
      });
    }

    if (ecosystem === "python") {
      const hasReqs = await fileExists(sandboxDir, "requirements.txt");
      const installCmd = hasReqs ? "pip install -r requirements.txt" : "pip install -e .";
      return runCommand(installCmd, {
        cwd: sandboxDir,
        timeoutMs: options.timeoutMs ?? 120_000,
      });
    }

    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };

  const cleanup = async (): Promise<void> => {
    activeSandboxes.delete(sandboxDir);
    logger.debug("sandbox", `Cleaning up sandbox at ${sandboxDir}`);
    await removeDirectory(sandboxDir);
  };

  return {
    dir: sandboxDir,
    ecosystem,
    patchManifest,
    install,
    cleanup,
  };
}
