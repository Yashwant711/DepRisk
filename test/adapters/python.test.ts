import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonAdapter } from "../../src/adapters/python/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("PythonAdapter", () => {
  it("detects a Python repository via pyproject.toml", async () => {
    const adapter = new PythonAdapter();
    const result = await adapter.detect(FIXTURE);
    expect(result.matches).toBe(true);
    expect(result.confidence).toBe(1);
  });

  it("does not detect a non-Python directory", async () => {
    const adapter = new PythonAdapter();
    const result = await adapter.detect(path.join(__dirname, "..", "fixtures", "node-basic"));
    expect(result.matches).toBe(false);
  });

  it("builds a normalized repository model from pyproject.toml", async () => {
    const adapter = new PythonAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);

    expect(model.ecosystem).toBe("python");
    expect(model.runtime.range).toBe(">=3.10");
    expect(model.runtime.provenance.source).toBe("pyproject.toml:project.requires-python");
    expect(model.testConfiguration.testRunner).toBe("pytest");
    expect(model.buildConfiguration.buildCommand?.value).toBe("python -m build");

    const fastapi = model.dependencies.find((d) => d.name === "fastapi");
    expect(fastapi?.rawRange).toBe(">=0.110,<1");

    const requests = model.dependencies.find((d) => d.name === "requests");
    expect(requests?.rawRange).toBe("==2.31.0");

    expect(model.devDependencies.map((d) => d.name).sort()).toEqual(["mypy", "pytest"]);
  });

  it("falls back to the declared range when no lockfile is present", async () => {
    const adapter = new PythonAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);
    const version = await adapter.getCurrentVersion(model, "requests");
    expect(version).toBe("2.31.0");
  });

  it("returns null for a package that is not a dependency", async () => {
    const adapter = new PythonAdapter();
    const model = await adapter.buildRepositoryModel(FIXTURE);
    const version = await adapter.getCurrentVersion(model, "django");
    expect(version).toBeNull();
  });

  it("parses a requirements.txt-only repository, skipping options and pinning extras correctly", async () => {
    const adapter = new PythonAdapter();
    const reqOnlyFixture = path.join(__dirname, "..", "fixtures", "python-requirements-only");
    const model = await adapter.buildRepositoryModel(reqOnlyFixture);

    expect(model.lockState.lockfile).toBe("requirements.txt");
    expect(model.lockState.fullyPinned).toBe(false);

    const names = model.dependencies.map((d) => d.name);
    expect(names).toContain("django");
    expect(names).toContain("celery");
    expect(names).toContain("python-dotenv");
    // the -e git+... line has no parseable name via our conservative regex and should be skipped, not crash
    expect(names).not.toContain("pkg");

    const django = model.dependencies.find((d) => d.name === "django");
    expect(django?.rawRange).toBe("==4.2.1");

    const dotenv = model.dependencies.find((d) => d.name === "python-dotenv");
    expect(dotenv?.rawRange).toBe("*"); // no version specifier given
  });
});
