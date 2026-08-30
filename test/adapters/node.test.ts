import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeAdapter } from "../../src/adapters/node/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");

describe("NodeAdapter", () => {
  it("detects a Node repository with high confidence when a lockfile is present", async () => {
    const adapter = new NodeAdapter();
    const result = await adapter.detect(FIXTURE);
    expect(result.matches).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it("does not detect a non-Node directory", async () => {
    const adapter = new NodeAdapter();
    const result = await adapter.detect(path.join(__dirname, "..", "fixtures", "python-basic"));
    expect(result.matches).toBe(false);
  });

  it("builds a normalized repository model with correct runtime, deps, and build info", async () => {
    const adapter = new NodeAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);

    expect(model.ecosystem).toBe("node");
    expect(model.packageManager?.value).toBe("npm");
    expect(model.runtime.range).toBe(">=18");
    expect(model.runtime.provenance.source).toBe("package.json:engines.node");
    expect(model.lockState.present).toBe(true);
    expect(model.lockState.lockfile).toBe("package-lock.json");
    expect(model.buildConfiguration.requiresCompilation).toBe(true); // tsconfig.json present
    expect(model.buildConfiguration.buildCommand?.value).toBe("npm run build");
    expect(model.testConfiguration.testCommand?.value).toBe("npm test");

    const reactDep = model.dependencies.find((d) => d.name === "react");
    expect(reactDep?.rawRange).toBe("^18.2.0");
    expect(reactDep?.kind).toBe("runtime");

    expect(model.devDependencies).toHaveLength(1);
    expect(model.devDependencies[0].name).toBe("typescript");
  });

  it("resolves the current installed version from the lockfile, not the manifest range", async () => {
    const adapter = new NodeAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);
    const version = await adapter.getCurrentVersion(model, "express");
    expect(version).toBe("4.18.2"); // exact lockfile version, not "^4.18.0"
  });

  it("returns null for a package that is not a dependency", async () => {
    const adapter = new NodeAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);
    const version = await adapter.getCurrentVersion(model, "left-pad");
    expect(version).toBeNull();
  });
});
