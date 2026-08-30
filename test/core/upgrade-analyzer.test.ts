import { describe, it, expect } from "vitest";
import { findUpgradeCandidates, analyzeUpgradeSafety } from "../../src/core/upgrade-analyzer.js";
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

describe("findUpgradeCandidates", () => {
  const versions: PackageVersion[] = [
    { name: "react", version: "19.0.0", dependencies: [], prerelease: false, deprecated: false, provenance: { source: "npm" } },
    { name: "react", version: "18.3.1", dependencies: [], prerelease: false, deprecated: false, provenance: { source: "npm" } },
    { name: "react", version: "18.3.0", dependencies: [], prerelease: false, deprecated: false, provenance: { source: "npm" } },
    { name: "react", version: "18.2.1", dependencies: [], prerelease: false, deprecated: false, provenance: { source: "npm" } },
    { name: "react", version: "18.2.0", dependencies: [], prerelease: false, deprecated: false, provenance: { source: "npm" } },
  ];

  it("identifies latest patch, latest minor in-major, and next/latest major", () => {
    const candidates = findUpgradeCandidates("18.2.0", versions, "node");

    const patch = candidates.find((c) => c.tier === "patch");
    const minor = candidates.find((c) => c.tier === "minor");
    const nextMajor = candidates.find((c) => c.tier === "next_major");

    expect(patch?.version.version).toBe("18.2.1");
    expect(minor?.version.version).toBe("18.3.1");
    expect(nextMajor?.version.version).toBe("19.0.0");
  });

  it("identifies latest version when package is not installed", () => {
    const candidates = findUpgradeCandidates(null, versions, "node");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].version.version).toBe("19.0.0");
  });
});

describe("analyzeUpgradeSafety", () => {
  const nodeModel: RepositoryModel = {
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
    buildConfiguration: { requiresCompilation: false, notes: [] },
    testConfiguration: { detected: false },
    sourceInformation: { sourceDirs: ["src"], testDirs: [] },
    manifestsRead: ["package.json"],
    warnings: [],
  };

  const sampleVersions: PackageVersion[] = [
    {
      name: "react",
      version: "19.0.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=20.0.0", provenance: { source: "npm" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "18.3.1",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "18.2.1",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "18.2.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
  ];

  it("recommends the safest in-major upgrade when major has runtime conflicts", async () => {
    const adapter = createMockAdapter({
      getCurrentVersion: async () => "18.2.0",
      fetchPackageVersions: async () => sampleVersions,
      fetchPackageVersion: async (_, ver) => sampleVersions.find((v) => v.version === ver) ?? null,
    });

    const analysis = await analyzeUpgradeSafety(nodeModel, "react", adapter, { skipInstall: true });

    expect(analysis.packageName).toBe("react");
    expect(analysis.currentVersion).toBe("18.2.0");
    expect(analysis.candidates.length).toBeGreaterThanOrEqual(2);

    expect(analysis.recommendedUpgrade?.candidate.version.version).toBe("18.3.1");
    expect(analysis.recommendedUpgrade?.risk).toBe("SAFE");

    const major19 = analysis.candidates.find((c) => c.candidate.version.version === "19.0.0");
    expect(major19?.result.overallStatus).toBe("FAIL");
    expect(major19?.risk).toBe("BLOCKED");
  });
});

