import type { PackageVersion, RepositoryModel } from "./model.js";

/**
 * Result of asking an adapter "does this repository belong to your ecosystem?"
 * Adapters must not throw during detection — an unsupported repo is a normal
 * outcome, not an error.
 */
export interface DetectionResult {
  matches: boolean;
  /** 0-1 confidence this repo belongs to this ecosystem (multiple adapters could match, e.g. a monorepo). */
  confidence: number;
  reason: string;
}

/**
 * The contract every ecosystem adapter must implement. The resolver core
 * (src/core/*) only ever talks to adapters through this interface — it must
 * never import ecosystem-specific parsing logic directly.
 */
export interface PackageAdapter {
  readonly ecosystem: RepositoryModel["ecosystem"];

  /** Cheap, filesystem-only check for whether `root` looks like this ecosystem. */
  detect(root: string): Promise<DetectionResult>;

  /** Parse manifests/lockfiles and build the normalized RepositoryModel. */
  buildRepositoryModel(root: string): Promise<RepositoryModel>;

  /**
   * Fetch known versions of `packageName` from this ecosystem's registry.
   * Should return newest-first. Implementations should apply reasonable
   * network timeouts and must not throw on "package not found" — return [].
   */
  fetchPackageVersions(packageName: string): Promise<PackageVersion[]>;

  /** Fetch full metadata for one specific version (dependencies, runtime requirement, etc). */
  fetchPackageVersion(packageName: string, version: string): Promise<PackageVersion | null>;

  /**
   * Given the repository model, resolve what version of `packageName` is
   * currently in use (from lockfile if available, else from manifest range).
   * Returns null if the package is not currently a dependency.
   */
  getCurrentVersion(model: RepositoryModel, packageName: string): Promise<string | null>;
}
