import semver from "semver";
import type { Ecosystem, RuntimeConstraint } from "./model.js";
import { satisfiesPep440, pep440Intersects } from "./pep440.js";

/**
 * Checks if a concrete package version satisfies a declared range/specifier.
 */
export function satisfiesVersion(version: string, range: string, ecosystem: Ecosystem): boolean {
  const cleanRange = range.trim();
  if (!cleanRange || cleanRange === "*") return true;

  if (ecosystem === "node") {
    // Coerce/clean version if needed (e.g. "v18.2.0" -> "18.2.0")
    const cleanVer = semver.clean(version) ?? semver.coerce(version)?.version ?? version;
    const validRange = semver.validRange(cleanRange);
    if (!validRange) return true; // if unparseable range, avoid false positives
    return semver.satisfies(cleanVer, validRange, { includePrerelease: true });
  }

  if (ecosystem === "python") {
    return satisfiesPep440(version, cleanRange);
  }

  return true;
}

/**
 * Checks if two version ranges intersect / can co-exist.
 */
export function rangesIntersect(range1: string, range2: string, ecosystem: Ecosystem): boolean {
  const r1 = range1.trim();
  const r2 = range2.trim();
  if (!r1 || r1 === "*" || !r2 || r2 === "*") return true;

  if (ecosystem === "node") {
    const vr1 = semver.validRange(r1);
    const vr2 = semver.validRange(r2);
    if (!vr1 || !vr2) return true;
    return semver.intersects(vr1, vr2, { includePrerelease: true });
  }

  if (ecosystem === "python") {
    return pep440Intersects(r1, r2);
  }

  return true;
}

export interface RuntimeCompatibilityResult {
  compatible: boolean;
  reason?: string;
  repoConstraintSummary: string;
  packageConstraintSummary: string;
}

/**
 * Evaluates whether a package's runtime requirements are compatible with the repository's runtime.
 */
export function checkRuntimeCompatibility(
  repoRuntime: RuntimeConstraint,
  pkgRuntime: RuntimeConstraint | undefined,
  ecosystem: Ecosystem,
): RuntimeCompatibilityResult {
  const pkgRange = pkgRuntime?.range?.trim();
  const pkgSummary = pkgRange ? `${pkgRuntime?.name ?? ecosystem} ${pkgRange}` : "any";

  if (!pkgRange || pkgRange === "*") {
    return {
      compatible: true,
      repoConstraintSummary: repoRuntime.range ?? repoRuntime.detectedVersion ?? "any",
      packageConstraintSummary: pkgSummary,
    };
  }

  // Case 1: Repository declares an explicit range (e.g. engines.node or requires-python)
  if (repoRuntime.range) {
    const repoRange = repoRuntime.range.trim();
    const repoSummary = `${repoRuntime.name} ${repoRange}`;

    const intersects = rangesIntersect(repoRange, pkgRange, ecosystem);
    if (!intersects) {
      return {
        compatible: false,
        reason: `Repository runtime range (${repoRange}) is disjoint from package runtime requirement (${pkgRange})`,
        repoConstraintSummary: repoSummary,
        packageConstraintSummary: pkgSummary,
      };
    }

    // If host version is also detected, test it as well
    if (repoRuntime.detectedVersion) {
      const satisfiesDetected = satisfiesVersion(repoRuntime.detectedVersion, pkgRange, ecosystem);
      if (!satisfiesDetected) {
        return {
          compatible: false,
          reason: `Current host environment runtime (${repoRuntime.detectedVersion}) does not satisfy package requirement (${pkgRange})`,
          repoConstraintSummary: `${repoSummary} (detected host: ${repoRuntime.detectedVersion})`,
          packageConstraintSummary: pkgSummary,
        };
      }
    }

    return {
      compatible: true,
      repoConstraintSummary: repoSummary,
      packageConstraintSummary: pkgSummary,
    };
  }

  // Case 2: Repository has a detected runtime version without an explicit constraint
  if (repoRuntime.detectedVersion) {
    const detected = repoRuntime.detectedVersion;
    const repoSummary = `${repoRuntime.name} ${detected} (host environment)`;
    const satisfies = satisfiesVersion(detected, pkgRange, ecosystem);
    if (!satisfies) {
      return {
        compatible: false,
        reason: `Host runtime environment (${detected}) does not satisfy package requirement (${pkgRange})`,
        repoConstraintSummary: repoSummary,
        packageConstraintSummary: pkgSummary,
      };
    }

    return {
      compatible: true,
      repoConstraintSummary: repoSummary,
      packageConstraintSummary: pkgSummary,
    };
  }

  return {
    compatible: true,
    repoConstraintSummary: "unspecified",
    packageConstraintSummary: pkgSummary,
  };
}
