import semver from "semver";
import type { PackageAdapter } from "./adapter.js";
import type { PackageVersion, RepositoryModel } from "./model.js";
import { parsePep440 } from "./pep440.js";
import {
  checkRuntimeCompatibility,
  rangesIntersect,
  satisfiesVersion,
} from "./version-matcher.js";

export interface VersionFilterOptions {
  major?: string;
  range?: string;
  includePrereleases?: boolean;
  limit?: number;
}

export interface DiscoveredVersion {
  version: string;
  compatible: boolean;
  satisfiesCurrentManifest: boolean;
  publishedAt?: string;
  deprecated?: boolean;
  deprecationMessage?: string;
  reasons: string[];
}

export interface VersionDiscoveryResult {
  packageName: string;
  currentVersion: string | null;
  declaredRange: string | null;
  compatible: DiscoveredVersion[];
  incompatible: DiscoveredVersion[];
  latestCompatible: DiscoveredVersion | null;
  totalChecked: number;
}

function matchesMajor(version: string, major: string, ecosystem: RepositoryModel["ecosystem"]): boolean {
  const targetMajor = parseInt(major, 10);
  if (isNaN(targetMajor)) return false;

  if (ecosystem === "node") {
    const parsed = semver.coerce(version);
    if (!parsed) return false;
    return parsed.major === targetMajor;
  }

  if (ecosystem === "python") {
    const parsed = parsePep440(version);
    if (!parsed || parsed.release.length === 0) return false;
    return parsed.release[0] === targetMajor;
  }

  return true;
}

/**
 * Discovers and filters compatible versions for a package against the repository graph.
 */
export async function discoverCompatibleVersions(
  model: RepositoryModel,
  allVersions: PackageVersion[],
  adapter: PackageAdapter,
  options: VersionFilterOptions = {},
): Promise<VersionDiscoveryResult> {
  if (allVersions.length === 0) {
    return {
      packageName: "",
      currentVersion: null,
      declaredRange: null,
      compatible: [],
      incompatible: [],
      latestCompatible: null,
      totalChecked: 0,
    };
  }

  const packageName = allVersions[0].name;
  const currentVersion = await adapter.getCurrentVersion(model, packageName);

  const directDep = [...model.dependencies, ...model.devDependencies].find(
    (d) => d.name.toLowerCase() === packageName.toLowerCase(),
  );
  const declaredRange = directDep?.rawRange ?? null;

  // Pre-fetch inverted peer dependencies metadata for direct dependencies in repo
  const invertedPeerRequirements: Array<{ depName: string; depVersion: string; requiredRange: string; optional?: boolean }> = [];
  for (const dep of model.dependencies) {
    if (dep.name.toLowerCase() === packageName.toLowerCase()) continue;
    const depVer = await adapter.getCurrentVersion(model, dep.name);
    if (!depVer) continue;
    try {
      const meta = await adapter.fetchPackageVersion(dep.name, depVer);
      if (meta) {
        const peer = meta.dependencies.find(
          (d) => d.kind === "peer" && d.name.toLowerCase() === packageName.toLowerCase(),
        );
        if (peer) {
          invertedPeerRequirements.push({
            depName: dep.name,
            depVersion: depVer,
            requiredRange: peer.rawRange,
            optional: peer.optional,
          });
        }
      }
    } catch {
      // ignore fetch errors
    }
  }

  // Filter versions by major / range / prerelease options
  let candidates = allVersions;

  if (!options.includePrereleases) {
    // If range explicitly asks for a prerelease or all versions are prereleases, keep them; otherwise filter out
    const hasNonPrerelease = candidates.some((v) => !v.prerelease);
    if (hasNonPrerelease) {
      candidates = candidates.filter((v) => !v.prerelease);
    }
  }

  if (options.major !== undefined) {
    candidates = candidates.filter((v) => matchesMajor(v.version, options.major!, model.ecosystem));
  }

  if (options.range !== undefined) {
    candidates = candidates.filter((v) => satisfiesVersion(v.version, options.range!, model.ecosystem));
  }

  const compatible: DiscoveredVersion[] = [];
  const incompatible: DiscoveredVersion[] = [];

  for (const target of candidates) {
    const reasons: string[] = [];
    let isCompatible = true;

    // 1. Runtime Compatibility
    const runtimeCheck = checkRuntimeCompatibility(model.runtime, target.runtimeRequirement, model.ecosystem);
    if (!runtimeCheck.compatible) {
      isCompatible = false;
      reasons.push(runtimeCheck.reason ?? `Incompatible runtime requirements`);
    }

    // 2. Platform Compatibility
    if (target.platformRequirement?.os && target.platformRequirement.os.length > 0) {
      const currentOs = process.platform;
      const declaredOs = model.platform?.os;
      const matchesOs = declaredOs
        ? declaredOs.some((o) => target.platformRequirement!.os!.includes(o))
        : target.platformRequirement.os.includes(currentOs);
      if (!matchesOs) {
        isCompatible = false;
        reasons.push(`Requires OS [${target.platformRequirement.os.join(", ")}]`);
      }
    }

    // 3. Peer Dependencies Declared by Target
    const peerDeps = target.dependencies.filter((d) => d.kind === "peer");
    for (const peer of peerDeps) {
      const installedPeer = [...model.dependencies, ...model.devDependencies].find(
        (d) => d.name.toLowerCase() === peer.name.toLowerCase(),
      );
      if (installedPeer) {
        const currentPeerVer = await adapter.getCurrentVersion(model, peer.name);
        const peerSatisfied = currentPeerVer
          ? satisfiesVersion(currentPeerVer, peer.rawRange, model.ecosystem)
          : rangesIntersect(installedPeer.rawRange, peer.rawRange, model.ecosystem);
        if (!peerSatisfied && !peer.optional) {
          isCompatible = false;
          reasons.push(`Requires peer ${peer.name} ${peer.rawRange} (repo has ${currentPeerVer ?? installedPeer.rawRange})`);
        }
      }
    }

    // 4. Inverted Peer Dependencies (Existing dependencies requiring target)
    for (const inv of invertedPeerRequirements) {
      const satisfiesInv = satisfiesVersion(target.version, inv.requiredRange, model.ecosystem);
      if (!satisfiesInv && !inv.optional) {
        isCompatible = false;
        reasons.push(`Incompatible with installed ${inv.depName}@${inv.depVersion} (requires peer ${packageName} ${inv.requiredRange})`);
      }
    }

    // 5. Shared Dependencies (Python)
    if (model.ecosystem === "python") {
      const runtimeDeps = target.dependencies.filter((d) => d.kind === "runtime");
      for (const dep of runtimeDeps) {
        const existing = model.dependencies.find((d) => d.name.toLowerCase() === dep.name.toLowerCase());
        if (existing) {
          const intersects = rangesIntersect(existing.rawRange, dep.rawRange, model.ecosystem);
          if (!intersects) {
            isCompatible = false;
            reasons.push(`Requires ${dep.name} ${dep.rawRange} (conflicts with repo ${existing.rawRange})`);
          }
        }
      }
    }

    const satisfiesCurrentManifest = declaredRange
      ? satisfiesVersion(target.version, declaredRange, model.ecosystem)
      : false;

    const item: DiscoveredVersion = {
      version: target.version,
      compatible: isCompatible,
      satisfiesCurrentManifest,
      publishedAt: target.publishedAt,
      deprecated: target.deprecated,
      deprecationMessage: target.deprecationMessage,
      reasons,
    };

    if (isCompatible) {
      compatible.push(item);
    } else {
      incompatible.push(item);
    }
  }

  const latestCompatible = compatible.length > 0 ? compatible[0] : null;

  return {
    packageName,
    currentVersion,
    declaredRange,
    compatible,
    incompatible,
    latestCompatible,
    totalChecked: candidates.length,
  };
}

