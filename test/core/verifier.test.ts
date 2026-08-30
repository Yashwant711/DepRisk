import { describe, it, expect } from "vitest";
import { verifyPackageVersion } from "../../src/core/verifier.js";
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

describe("verifyPackageVersion", () => {
  const baseModel: RepositoryModel = {
    root: "/app",
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
    sourceInformation: { sourceDirs: ["src"], testDirs: ["test"] },
    manifestsRead: ["package.json"],
    warnings: [],
  };

  it("fails fast during static analysis if runtime requirements are disjoint", async () => {
    const target: PackageVersion = {
      name: "react",
      version: "19.0.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=20.0.0", provenance: { source: "npm:react@19.0.0" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    };

    const adapter = createMockAdapter({ getCurrentVersion: async () => "18.2.0" });
    const result = await verifyPackageVersion(baseModel, target, adapter, { skipInstall: true });

    expect(result.overallStatus).toBe("FAIL");
    expect(result.runtime).toBe("FAIL");
    expect(result.resolution).toBe("FAIL"); // also manifest mismatch ^18.2.0 vs 19.0.0
    expect(result.build).toBe("UNKNOWN");
    expect(result.tests).toBe("UNKNOWN");
  });

  it("passes when target is compatible and active steps are skipped", async () => {
    const target: PackageVersion = {
      name: "react",
      version: "18.2.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm:react@18.2.0" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    };

    const adapter = createMockAdapter({ getCurrentVersion: async () => "18.2.0" });
    const result = await verifyPackageVersion(baseModel, target, adapter, { skipInstall: true });

    expect(result.overallStatus).toBe("PASS");
    expect(result.resolution).toBe("PASS");
    expect(result.runtime).toBe("PASS");
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });
});

