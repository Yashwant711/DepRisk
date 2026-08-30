import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planMigration, findAffectedSourceFiles } from "../../src/core/migration-planner.js";
import type { PackageAdapter } from "../../src/core/adapter.js";
import type { PackageVersion, RepositoryModel } from "../../src/core/model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

function createMockAdapter(overrides?: Partial<PackageAdapter>): PackageAdapter {
  return {
    ecosystem: "node",
    detect: async () => ({ matches: true, confidence: 1, reason: "mock" }),
    buildRepositoryModel: async () => ({} as RepositoryModel),
    fetchPackageVersions: async () => [],
    fetchPackageVersion: async () => null,
    getCurrentVersion: async () => null,
    ...overrides,
  };
}

describe("findAffectedSourceFiles", () => {
  it("finds source files importing react in node-basic fixture", async () => {
    const files = await findAffectedSourceFiles(NODE_FIXTURE, ["src"], "react", "node");
    expect(files).toContain(path.normalize("src/index.ts"));
  });

  it("finds source files importing fastapi in python-basic fixture", async () => {
    const files = await findAffectedSourceFiles(PYTHON_FIXTURE, ["src"], "fastapi", "python");
    expect(files).toContain(path.normalize("src/main.py"));
  });
});

describe("planMigration", () => {
  const nodeModel: RepositoryModel = {
    root: NODE_FIXTURE,
    ecosystem: "node",
    packageManager: { value: "npm", provenance: { source: "package.json" } },
    runtime: { name: "node", range: ">=18 <20", provenance: { source: "package.json:engines.node" } },
    platform: null,
    dependencies: [
      { name: "react", rawRange: "^18.2.0", kind: "runtime", provenance: { source: "package.json:dependencies.react" } },
    ],
    devDependencies: [],
    lockState: { present: true, lockfile: "package-lock.json", fullyPinned: true },
    buildConfiguration: { requiresCompilation: true, buildCommand: { value: "npm run build", provenance: { source: "pkg" } }, notes: [] },
    testConfiguration: { detected: true, testCommand: { value: "npm test", provenance: { source: "pkg" } } },
    sourceInformation: { sourceDirs: ["src"], testDirs: [] },
    manifestsRead: ["package.json"],
    warnings: [],
  };

  it("generates a structured migration plan for react@19.0.0", async () => {
    const target: PackageVersion = {
      name: "react",
      version: "19.0.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=20.0.0", provenance: { source: "npm:react@19.0.0:engines.node" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:react@19.0.0" },
    };

    const adapter = createMockAdapter({ getCurrentVersion: async () => "18.2.0" });
    const plan = await planMigration(nodeModel, target, adapter);

    expect(plan.packageName).toBe("react");
    expect(plan.targetVersion).toBe("19.0.0");
    expect(plan.runtimeChanges.length).toBeGreaterThan(0);
    expect(plan.runtimeChanges[0].required).toBe(">=20.0.0");

    expect(plan.dependencyChanges.some((d) => d.package === "react" && d.targetRange === "^19.0.0")).toBe(true);
    expect(plan.installCommand).toContain("npm install react@^19.0.0");
    expect(plan.steps.length).toBeGreaterThanOrEqual(4);
    expect(plan.steps.map((s) => s.category)).toContain("runtime");
    expect(plan.steps.map((s) => s.category)).toContain("dependency");
    expect(plan.steps.map((s) => s.category)).toContain("source");
    expect(plan.steps.map((s) => s.category)).toContain("verification");
  });
});

