import path from "node:path";
import type { PackageAdapter, DetectionResult } from "../../core/adapter.js";
import type { PackageVersion, RepositoryModel } from "../../core/model.js";
import { detectNode, buildNodeRepositoryModel } from "./repository.js";
import { fetchNpmVersion, fetchNpmVersions } from "./registry.js";
import { readJsonFile } from "../../util/fs.js";

interface PackageLockV2 {
  packages?: Record<string, { version?: string }>;
}

export class NodeAdapter implements PackageAdapter {
  readonly ecosystem = "node" as const;

  async detect(root: string): Promise<DetectionResult> {
    const result = await detectNode(root);
    return result;
  }

  async buildRepositoryModel(root: string): Promise<RepositoryModel> {
    return buildNodeRepositoryModel(root);
  }

  async fetchPackageVersions(packageName: string): Promise<PackageVersion[]> {
    return fetchNpmVersions(packageName);
  }

  async fetchPackageVersion(packageName: string, version: string): Promise<PackageVersion | null> {
    return fetchNpmVersion(packageName, version);
  }

  async getCurrentVersion(model: RepositoryModel, packageName: string): Promise<string | null> {
    // Prefer the lockfile (npm v2/v3 format) for an exact installed version.
    if (model.lockState.lockfile === "package-lock.json") {
      const lock = await readJsonFile<PackageLockV2>(model.root, "package-lock.json");
      const entry = lock?.packages?.[`node_modules/${packageName}`];
      if (entry?.version) return entry.version;
    }
    // Fall back to the declared range in the manifest — not exact, but tells us the package is present.
    const declared = [...model.dependencies, ...model.devDependencies].find((d) => d.name === packageName);
    if (!declared) return null;
    return declared.rawRange.replace(/^[\^~>=<]+/, "") || null;
  }
}

export function isNodeAdapter(a: PackageAdapter): a is NodeAdapter {
  return a.ecosystem === "node";
}
