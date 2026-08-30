import { describe, it, expect } from "vitest";
import { evaluateCompatibility } from "../../src/core/constraint-engine.js";
import type { PackageAdapter } from "../../src/core/adapter.js";
import type { PackageVersion, RepositoryModel } from "../../src/core/model.js";

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

describe("Constraint Engine (evaluateCompatibility)", () => {
  const baseNodeModel: RepositoryModel = {
    root: "/app",
    ecosystem: "node",
    packageManager: { value: "npm", provenance: { source: "package-lock.json" } },
    runtime: { name: "node", range: ">=18", provenance: { source: "package.json:engines.node" } },
    platform: null,
    dependencies: [
      { name: "react", rawRange: "^18.2.0", kind: "runtime", provenance: { source: "package.json:dependencies.react" } },
      { name: "react-dom", rawRange: "^18.2.0", kind: "runtime", provenance: { source: "package.json:dependencies.react-dom" } },
    ],
    devDependencies: [],
    lockState: { present: true, lockfile: "package-lock.json", fullyPinned: true },
    buildConfiguration: { requiresCompilation: false, notes: [] },
    testConfiguration: { detected: false },
    sourceInformation: { sourceDirs: ["src"], testDirs: [] },
    manifestsRead: ["package.json"],
    warnings: [],
  };

  it("detects direct dependency range mismatch", async () => {
    const adapter = createMockAdapter({
      getCurrentVersion: async (_, pkg) => (pkg === "react" ? "18.2.0" : null),
    });

    const target: PackageVersion = {
      name: "react",
      version: "19.0.0",
      dependencies: [],
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:react@19.0.0" },
    };

    const result = await evaluateCompatibility(baseNodeModel, target, adapter);
    expect(result.canCoexist).toBe(false);
    expect(result.verdict).toBe("CANNOT_COEXIST");
    expect(result.conflicts.some((c) => c.category === "direct_range")).toBe(true);
    expect(result.conflicts[0].message).toContain('Declared range "^18.2.0" rejects target version "19.0.0"');
  });

  it("detects runtime incompatibility", async () => {
    const model: RepositoryModel = {
      ...baseNodeModel,
      runtime: { name: "node", range: ">=16 <18", provenance: { source: "package.json:engines.node" } },
      dependencies: [],
    };

    const target: PackageVersion = {
      name: "some-lib",
      version: "2.0.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=20.0.0", provenance: { source: "npm:some-lib@2.0.0:engines.node" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:some-lib@2.0.0" },
    };

    const result = await evaluateCompatibility(model, target, createMockAdapter());
    expect(result.canCoexist).toBe(false);
    expect(result.conflicts.some((c) => c.category === "runtime_incompatibility")).toBe(true);
  });

  it("detects unmet peer dependency from target package", async () => {
    const adapter = createMockAdapter({
      getCurrentVersion: async (_, pkg) => (pkg === "react" ? "18.2.0" : null),
    });

    const target: PackageVersion = {
      name: "next-gen-ui",
      version: "1.0.0",
      dependencies: [
        {
          name: "react",
          rawRange: "^19.0.0",
          kind: "peer",
          provenance: { source: "npm:next-gen-ui@1.0.0:peerDependencies.react" },
        },
      ],
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:next-gen-ui@1.0.0" },
    };

    const result = await evaluateCompatibility(baseNodeModel, target, adapter);
    expect(result.canCoexist).toBe(false);
    const peerConflict = result.conflicts.find((c) => c.category === "peer_dependency_unmet");
    expect(peerConflict).toBeDefined();
    expect(peerConflict?.message).toContain('Requires peer "react ^19.0.0", but repository has "18.2.0"');
  });

  it("detects inverted peer dependency conflict from existing repo dependencies", async () => {
    const adapter = createMockAdapter({
      getCurrentVersion: async (_, pkg) => (pkg === "react-dom" ? "18.2.0" : pkg === "react" ? "18.2.0" : null),
      fetchPackageVersion: async (pkg, ver) => {
        if (pkg === "react-dom" && ver === "18.2.0") {
          return {
            name: "react-dom",
            version: "18.2.0",
            dependencies: [
              {
                name: "react",
                rawRange: "^18.2.0",
                kind: "peer",
                provenance: { source: "npm:react-dom@18.2.0:peerDependencies.react" },
              },
            ],
            prerelease: false,
            deprecated: false,
            provenance: { source: "npm:react-dom@18.2.0" },
          };
        }
        return null;
      },
    });

    const target: PackageVersion = {
      name: "react",
      version: "19.0.0",
      dependencies: [],
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:react@19.0.0" },
    };

    const result = await evaluateCompatibility(baseNodeModel, target, adapter);
    expect(result.canCoexist).toBe(false);
    const inverted = result.conflicts.find((c) => c.category === "inverted_peer_conflict");
    expect(inverted).toBeDefined();
    expect(inverted?.message).toContain('Installed package "react-dom@18.2.0" requires peer "react ^18.2.0"');
  });

  it("detects transitive/shared dependency conflict in Python", async () => {
    const pythonModel: RepositoryModel = {
      root: "/pyapp",
      ecosystem: "python",
      packageManager: { value: "pip", provenance: { source: "requirements.txt" } },
      runtime: { name: "python", range: ">=3.10", provenance: { source: "pyproject.toml" } },
      platform: null,
      dependencies: [
        { name: "requests", rawRange: "==2.31.0", kind: "runtime", provenance: { source: "pyproject.toml:dependencies.requests" } },
      ],
      devDependencies: [],
      lockState: { present: false, fullyPinned: false },
      buildConfiguration: { requiresCompilation: false, notes: [] },
      testConfiguration: { detected: false },
      sourceInformation: { sourceDirs: ["src"], testDirs: [] },
      manifestsRead: ["pyproject.toml"],
      warnings: [],
    };

    const adapter = createMockAdapter({
      ecosystem: "python",
      getCurrentVersion: async () => "2.31.0",
    });

    const target: PackageVersion = {
      name: "new-http-tool",
      version: "1.0.0",
      dependencies: [
        {
          name: "requests",
          rawRange: ">=2.32.0",
          kind: "runtime",
          provenance: { source: "pypi:new-http-tool@1.0.0:requires_dist" },
        },
      ],
      prerelease: false,
      deprecated: false,
      provenance: { source: "pypi:new-http-tool@1.0.0" },
    };

    const result = await evaluateCompatibility(pythonModel, target, adapter);
    expect(result.canCoexist).toBe(false);
    const trans = result.conflicts.find((c) => c.category === "transitive_conflict");
    expect(trans).toBeDefined();
    expect(trans?.message).toContain('Requires "requests >=2.32.0", but repository pins/declares "requests ==2.31.0"');
  });

  it("reports COMPATIBLE when all constraints are satisfied", async () => {
    const target: PackageVersion = {
      name: "react",
      version: "18.2.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18", provenance: { source: "npm:react@18.2.0:engines.node" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm:react@18.2.0" },
    };

    const adapter = createMockAdapter({
      getCurrentVersion: async () => "18.2.0",
    });

    const result = await evaluateCompatibility(baseNodeModel, target, adapter);
    expect(result.canCoexist).toBe(true);
    expect(result.verdict).toBe("COMPATIBLE");
    expect(result.conflicts).toHaveLength(0);
  });
});

