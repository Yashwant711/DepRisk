import { readFile, writeFile, access, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export async function fileExists(root: string, relPath: string): Promise<boolean> {
  try {
    await access(path.join(root, relPath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(root: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relPath), "utf-8");
  } catch {
    return null;
  }
}

export async function writeTextFile(root: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

export async function readJsonFile<T = unknown>(root: string, relPath: string): Promise<T | null> {
  const text = await readTextFile(root, relPath);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile<T = unknown>(root: string, relPath: string, data: T): Promise<void> {
  await writeTextFile(root, relPath, JSON.stringify(data, null, 2) + "\n");
}

export async function removeDirectory(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const DEFAULT_IGNORE_PATTERNS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".turbo",
  ".next",
  "coverage",
]);

/**
 * Copies a repository tree into a destination directory, skipping heavy ignored folders.
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (DEFAULT_IGNORE_PATTERNS.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await cp(srcPath, destPath);
    }
  }
}
