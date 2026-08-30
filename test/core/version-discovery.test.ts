import { describe, it, expect } from "vitest";
import { discoverCompatibleVersions } from "../../src/core/version-discovery.js";
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

describe("discoverCompatibleVersions", () => {
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
      runtimeRequirement: { name: "node", range: ">=20.0.0", provenance: { source: "npm:react@19.0.0" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "18.3.1",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm:react@18.3.1" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "18.2.0",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=18.0.0", provenance: { source: "npm:react@18.2.0" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
    {
      name: "react",
      version: "17.0.2",
      dependencies: [],
      runtimeRequirement: { name: "node", range: ">=12.0.0", provenance: { source: "npm:react@17.0.2" } },
      prerelease: false,
      deprecated: false,
      provenance: { source: "npm" },
    },
  ];

  it("filters compatible versions by runtime and separates incompatible versions", async () => {
    const adapter = createMockAdapter({
      getCurrentVersion: async () => "18.2.0",
    });

    const result = await discoverCompatibleVersions(nodeModel, sampleVersions, adapter);

    expect(result.packageName).toBe("react");
    expect(result.currentVersion).toBe("18.2.0");
    expect(result.declaredRange).toBe("^18.2.0");

    // 19.0.0 requires node >=20 which is disjoint from repo's >=18 <20
    expect(result.incompatible.map((v) => v.version)).toContain("19.0.0");
    expect(result.compatible.map((v) => v.version)).toEqual(["18.3.1", "18.2.0", "17.0.2"]);
    expect(result.latestCompatible?.version).toBe("18.3.1");

    // 18.2.0 and 18.3.1 satisfy ^18.2.0; 17.0.2 is adoptable (compatible with graph, but outside ^18.2.0)
    const v18_2 = result.compatible.find((v) => v.version === "18.2.0");
    const v17_0 = result.compatible.find((v) => v.version === "17.0.2");
    expect(v18_2?.satisfiesCurrentManifest).toBe(true);
    expect(v17_0?.satisfiesCurrentManifest).toBe(false);
  });

  it("filters by --major option", async () => {
    const adapter = createMockAdapter();
    const result = await discoverCompatibleVersions(nodeModel, sampleVersions, adapter, { major: "18" });

    expect(result.totalChecked).toBe(2);
    expect(result.compatible.map((v) => v.version)).toEqual(["18.3.1", "18.2.0"]);
  });

  it("filters by --range option", async () => {
    const adapter = createMockAdapter();
    const result = await discoverCompatibleVersions(nodeModel, sampleVersions, adapter, { range: ">=18.3.0" });

    expect(result.totalChecked).toBe(2); // 19.0.0 and 18.3.1
    expect(result.compatible.map((v) => v.version)).toEqual(["18.3.1"]);
    expect(result.incompatible.map((v) => v.version)).toEqual(["19.0.0"]);
  });

  it("handles Python version discovery and PEP 440 major filtering", async () => {
    const pythonModel: RepositoryModel = {
      root: "/pyapp",
      ecosystem: "python",
      packageManager: { value: "pip", provenance: { source: "pyproject.toml" } },
      runtime: { name: "python", range: ">=3.10", provenance: { source: "pyproject.toml" } },
      platform: null,
      dependencies: [
        { name: "fastapi", rawRange: ">=0.110,<1", kind: "runtime", provenance: { source: "pyproject.toml" } },
      ],
      devDependencies: [],
      lockState: { present: false, fullyPinned: false },
      buildConfiguration: { requiresCompilation: false, notes: [] },
      testConfiguration: { detected: false },
      sourceInformation: { sourceDirs: ["."], testDirs: [] },
      manifestsRead: ["pyproject.toml"],
      warnings: [],
    };

    const pyVersions: PackageVersion[] = [
      {
        name: "fastapi",
        version: "0.111.0",
        dependencies: [],
        runtimeRequirement: { name: "python", range: ">=3.8", provenance: { source: "pypi" } },
        prerelease: false,
        deprecated: false,
        provenance: { source: "pypi" },
      },
      {
        name: "fastapi",
        version: "0.95.0",
        dependencies: [],
        runtimeRequirement: { name: "python", range: ">=3.7", provenance: { source: "pypi" } },
        prerelease: false,
        deprecated: false,
        provenance: { source: "pypi" },
      },
    ];

    const adapter = createMockAdapter({ ecosystem: "python" });
    const result = await discoverCompatibleVersions(pythonModel, pyVersions, adapter);

    expect(result.compatible.map((v) => v.version)).toEqual(["0.111.0", "0.95.0"]);
    expect(result.latestCompatible?.version).toBe("0.111.0");
  });
});

