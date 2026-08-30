import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedEnvironment } from "../../src/core/environment.js";
import { fileExists, readJsonFile, readTextFile } from "../../src/util/fs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("createIsolatedEnvironment", () => {
  it("creates a sandbox for Node, patches package.json, and cleans up", async () => {
    const env = await createIsolatedEnvironment(NODE_FIXTURE, "node");

    expect(await fileExists(env.dir, "package.json")).toBe(true);

    const patched = await env.patchManifest("react", "19.0.0");
    expect(patched).toBe(true);

    const pkg = await readJsonFile<any>(env.dir, "package.json");
    expect(pkg?.dependencies?.react).toBe("19.0.0");

    await env.cleanup();
    expect(await fileExists(env.dir, "package.json")).toBe(false);
  });

  it("creates a sandbox for Python, patches pyproject.toml, and cleans up", async () => {
    const env = await createIsolatedEnvironment(PYTHON_FIXTURE, "python");

    expect(await fileExists(env.dir, "pyproject.toml")).toBe(true);

    const patched = await env.patchManifest("fastapi", "0.111.0");
    expect(patched).toBe(true);

    const text = await readTextFile(env.dir, "pyproject.toml");
    expect(text).toContain("fastapi==0.111.0");

    await env.cleanup();
    expect(await fileExists(env.dir, "pyproject.toml")).toBe(false);
  });
});

