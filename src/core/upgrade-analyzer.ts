import semver from "semver";
import type { PackageAdapter } from "./adapter.js";
import type {
  CompatibilityResult,
  Ecosystem,
  PackageVersion,
  RepositoryModel,
} from "./model.js";
import { comparePep440, parsePep440 } from "./pep440.js";
import { verifyPackageVersion, type VerificationOptions } from "./verifier.js";
import { logger } from "../util/logger.js";

export type UpgradeTier = "patch" | "minor" | "next_major" | "latest_major" | "latest";

export interface UpgradeCandidate {
  version: PackageVersion;
  tier: UpgradeTier;
  tierLabel: string;
}

export interface CandidateEvaluation {
  candidate: UpgradeCandidate;
  result: CompatibilityResult;
  risk: "SAFE" | "LOW_RISK" | "BREAKING_CHANGES" | "BLOCKED";
  summary: string;
}

export interface UpgradeSafetyAnalysis {
  packageName: string;
  currentVersion: string | null;
  declaredRange: string | null;
  candidates: CandidateEvaluation[];
  recommendedUpgrade: CandidateEvaluation | null;
  isAlreadyLatest: boolean;
  message: string;
}

/**
 * Identifies key upgrade candidates (latest patch, latest minor, next major, latest major).
 */
export function findUpgradeCandidates(
  currentVersion: string | null,
  allVersions: PackageVersion[],
  ecosystem: Ecosystem,
): UpgradeCandidate[] {
  // Filter out prereleases unless only prereleases exist
  let versions = allVersions.filter((v) => !v.prerelease && !v.deprecated);
  if (versions.length === 0) {
    versions = allVersions.filter((v) => !v.deprecated);
  }
  if (versions.length === 0) {
    versions = allVersions;
  }

  if (versions.length === 0) return [];

  // If not currently installed, the latest stable release is the primary candidate
  if (!currentVersion) {
    return [
      {
        version: versions[0],
        tier: "latest",
        tierLabel: "Latest Stable",
      },
    ];
  }

  const candidates: UpgradeCandidate[] = [];
  const addedVersions = new Set<string>();

  if (ecosystem === "node") {
    const curSemver = semver.coerce(currentVersion);
    if (!curSemver) {
      return [{ version: versions[0], tier: "latest", tierLabel: "Latest Stable" }];
    }

    const curMajor = curSemver.major;
    const curMinor = curSemver.minor;

    // 1. Latest Patch within current minor
    const patchCandidates = versions.filter((v) => {
      const parsed = semver.coerce(v.version);
      return parsed && parsed.major === curMajor && parsed.minor === curMinor && semver.gt(parsed, curSemver);
    });
    if (patchCandidates.length > 0) {
      const bestPatch = patchCandidates[0];
      candidates.push({ version: bestPatch, tier: "patch", tierLabel: "Latest Patch" });
      addedVersions.add(bestPatch.version);
    }

    // 2. Latest Minor within current major
    const minorCandidates = versions.filter((v) => {
      const parsed = semver.coerce(v.version);
      return parsed && parsed.major === curMajor && parsed.minor > curMinor && semver.gt(parsed, curSemver);
    });
    if (minorCandidates.length > 0) {
      const bestMinor = minorCandidates[0];
      if (!addedVersions.has(bestMinor.version)) {
        candidates.push({ version: bestMinor, tier: "minor", tierLabel: "Latest Minor (In-Major)" });
        addedVersions.add(bestMinor.version);
      }
    }

    // 3. Next Major
    const nextMajorCandidates = versions.filter((v) => {
      const parsed = semver.coerce(v.version);
      return parsed && parsed.major === curMajor + 1;
    });
    if (nextMajorCandidates.length > 0) {
      const bestNextMajor = nextMajorCandidates[0];
      if (!addedVersions.has(bestNextMajor.version)) {
        candidates.push({ version: bestNextMajor, tier: "next_major", tierLabel: `Next Major (${curMajor + 1}.x)` });
        addedVersions.add(bestNextMajor.version);
      }
    }

    // 4. Latest Overall Major
    const latestOverall = versions[0];
    const parsedLatest = semver.coerce(latestOverall.version);
    if (parsedLatest && semver.gt(parsedLatest, curSemver) && !addedVersions.has(latestOverall.version)) {
      candidates.push({ version: latestOverall, tier: "latest_major", tierLabel: "Latest Release" });
      addedVersions.add(latestOverall.version);
    }
  } else if (ecosystem === "python") {
    const curPep = parsePep440(currentVersion);
    if (!curPep || curPep.release.length === 0) {
      return [{ version: versions[0], tier: "latest", tierLabel: "Latest Stable" }];
    }

    const curMajor = curPep.release[0];
    const curMinor = curPep.release[1] ?? 0;

    // 1. Latest Patch within current minor
    const patchCandidates = versions.filter((v) => {
      const parsed = parsePep440(v.version);
      return (
        parsed &&
        parsed.release[0] === curMajor &&
        (parsed.release[1] ?? 0) === curMinor &&
        comparePep440(parsed, curPep) > 0
      );
    });
    if (patchCandidates.length > 0) {
      const bestPatch = patchCandidates[0];
      candidates.push({ version: bestPatch, tier: "patch", tierLabel: "Latest Patch" });
      addedVersions.add(bestPatch.version);
    }

    // 2. Latest Minor within current major
    const minorCandidates = versions.filter((v) => {
      const parsed = parsePep440(v.version);
      return (
        parsed &&
        parsed.release[0] === curMajor &&
        (parsed.release[1] ?? 0) > curMinor &&
        comparePep440(parsed, curPep) > 0
      );
    });
    if (minorCandidates.length > 0) {
      const bestMinor = minorCandidates[0];
      if (!addedVersions.has(bestMinor.version)) {
        candidates.push({ version: bestMinor, tier: "minor", tierLabel: "Latest Minor (In-Major)" });
        addedVersions.add(bestMinor.version);
      }
    }

    // 3. Next Major
    const nextMajorCandidates = versions.filter((v) => {
      const parsed = parsePep440(v.version);
      return parsed && parsed.release[0] === curMajor + 1;
    });
    if (nextMajorCandidates.length > 0) {
      const bestNextMajor = nextMajorCandidates[0];
      if (!addedVersions.has(bestNextMajor.version)) {
        candidates.push({ version: bestNextMajor, tier: "next_major", tierLabel: `Next Major (${curMajor + 1}.x)` });
        addedVersions.add(bestNextMajor.version);
      }
    }

    // 4. Latest Overall
    const latestOverall = versions[0];
    const parsedLatest = parsePep440(latestOverall.version);
    if (parsedLatest && comparePep440(parsedLatest, curPep) > 0 && !addedVersions.has(latestOverall.version)) {
      candidates.push({ version: latestOverall, tier: "latest_major", tierLabel: "Latest Release" });
      addedVersions.add(latestOverall.version);
    }
  }

  return candidates;
}

/**
 * Runs upgrade safety analysis across candidate releases for a package.
 */
export async function analyzeUpgradeSafety(
  model: RepositoryModel,
  packageName: string,
  adapter: PackageAdapter,
  options: VerificationOptions = {},
): Promise<UpgradeSafetyAnalysis> {
  const currentVersion = await adapter.getCurrentVersion(model, packageName);

  const directDep = [...model.dependencies, ...model.devDependencies].find(
    (d) => d.name.toLowerCase() === packageName.toLowerCase(),
  );
  const declaredRange = directDep?.rawRange ?? null;

  logger.debug("resolution", `Fetching all versions of ${packageName} for upgrade safety analysis...`);
  const allVersions = await adapter.fetchPackageVersions(packageName);

  if (allVersions.length === 0) {
    return {
      packageName,
      currentVersion,
      declaredRange,
      candidates: [],
      recommendedUpgrade: null,
      isAlreadyLatest: false,
      message: `Package "${packageName}" not found on the registry.`,
    };
  }

  const candidateTiers = findUpgradeCandidates(currentVersion, allVersions, model.ecosystem);

  if (candidateTiers.length === 0 && currentVersion) {
    return {
      packageName,
      currentVersion,
      declaredRange,
      candidates: [],
      recommendedUpgrade: null,
      isAlreadyLatest: true,
      message: `Package "${packageName}" is already at the latest available version (${currentVersion}).`,
    };
  }

  const evaluations: CandidateEvaluation[] = [];

  for (const cand of candidateTiers) {
    // Fetch full per-version metadata if needed
    let fullMeta: PackageVersion | null = cand.version;
    if (fullMeta.dependencies.length === 0) {
      const fetched = await adapter.fetchPackageVersion(packageName, cand.version.version);
      if (fetched) fullMeta = fetched;
    }

    const result = await verifyPackageVersion(model, fullMeta, adapter, options);

    let risk: CandidateEvaluation["risk"] = "SAFE";
    let summary = "Compatible upgrade";

    if (result.overallStatus === "FAIL") {
      risk = "BLOCKED";
      const failureEv = result.evidence.find((e) => e.status === "FAIL");
      summary = failureEv ? failureEv.summary : "Conflicts prevent adoption";
    } else if (result.overallStatus === "WARNING") {
      risk = "LOW_RISK";
      summary = result.warnings[0] ?? "Compatible with warnings";
    } else {
      if (cand.tier === "latest_major" || cand.tier === "next_major") {
        risk = "LOW_RISK";
        summary = "Major upgrade — all checks pass cleanly";
      } else {
        risk = "SAFE";
        summary = "Safe in-major upgrade — no breaking changes detected";
      }
    }

    evaluations.push({
      candidate: cand,
      result,
      risk,
      summary,
    });
  }

  // Determine recommendation:
  // 1. Prefer the highest passing in-major version (minor/patch) as safest
  // 2. If no in-major candidate or major is also clean, recommend highest passing release
  let recommended: CandidateEvaluation | null = null;

  const passing = evaluations.filter((e) => e.result.overallStatus === "PASS");
  const inMajorPassing = passing.filter((e) => e.candidate.tier === "minor" || e.candidate.tier === "patch");

  if (inMajorPassing.length > 0) {
    const minorPass = inMajorPassing.find((e) => e.candidate.tier === "minor");
    recommended = minorPass ?? inMajorPassing[0];
  } else if (passing.length > 0) {
    recommended = passing[0];
  } else {
    // If none fully passed, pick warning candidate if any
    const warningCandidates = evaluations.filter((e) => e.result.overallStatus === "WARNING");
    if (warningCandidates.length > 0) {
      recommended = warningCandidates[0];
    }
  }

  return {
    packageName,
    currentVersion,
    declaredRange,
    candidates: evaluations,
    recommendedUpgrade: recommended,
    isAlreadyLatest: false,
    message: recommended
      ? `Recommended upgrade: ${packageName}@${recommended.candidate.version.version} (${recommended.candidate.tierLabel})`
      : `No safe automated upgrades found for ${packageName}. Review blocking conflicts.`,
  };
}
