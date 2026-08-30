import type { PackageAdapter } from "./adapter.js";
import type {
  EvidenceItem,
  PackageVersion,
  RepositoryModel,
  RequiredChange,
} from "./model.js";
import {
  checkRuntimeCompatibility,
  rangesIntersect,
  satisfiesVersion,
} from "./version-matcher.js";

export type ConflictCategory =
  | "direct_range"
  | "runtime_incompatibility"
  | "peer_dependency_unmet"
  | "inverted_peer_conflict"
  | "transitive_conflict"
  | "platform_unsupported"
  | "yanked_or_deprecated";

export type ConflictSeverity = "error" | "warning";

export interface ConflictReason {
  category: ConflictCategory;
  severity: ConflictSeverity;
  title: string;
  message: string;
  source?: string;
  remediation?: string;
}

export interface ResolutionAnalysis {
  packageName: string;
  targetVersion: string;
  currentVersion: string | null;
  canCoexist: boolean;
  verdict: "CANNOT_COEXIST" | "COMPATIBLE" | "COMPATIBLE_WITH_WARNINGS";
  conflicts: ConflictReason[];
  warnings: ConflictReason[];
  requiredChanges: RequiredChange[];
  evidence: EvidenceItem[];
}

/**
 * Core Constraint Engine for evaluating whether a target package version
 * can coexist with the current repository dependency graph and environment.
 */
export async function evaluateCompatibility(
  model: RepositoryModel,
  target: PackageVersion,
  adapter: PackageAdapter,
): Promise<ResolutionAnalysis> {
  const conflicts: ConflictReason[] = [];
  const warnings: ConflictReason[] = [];
  const requiredChanges: RequiredChange[] = [];
  const evidence: EvidenceItem[] = [];

  const currentVersion = await adapter.getCurrentVersion(model, target.name);

  // 1. Direct Dependency Range Check
  const directDep = [...model.dependencies, ...model.devDependencies].find(
    (d) => d.name.toLowerCase() === target.name.toLowerCase(),
  );

  if (directDep) {
    const satisfiesDirect = satisfiesVersion(target.version, directDep.rawRange, model.ecosystem);
    if (!satisfiesDirect) {
      const conflict: ConflictReason = {
        category: "direct_range",
        severity: "error",
        title: "Direct Dependency Range Mismatch",
        message: `Declared range "${directDep.rawRange}" rejects target version "${target.version}".`,
        source: directDep.provenance.source,
        remediation: `Update declared range in ${directDep.provenance.source} to include "${target.version}" (e.g. ^${target.version} or ==${target.version})`,
      };
      conflicts.push(conflict);
      evidence.push({
        stage: "resolution",
        status: "FAIL",
        summary: conflict.message,
        location: directDep.provenance.source,
        detail: `Expected version satisfying ${directDep.rawRange}, got ${target.version}`,
      });
      requiredChanges.push({
        category: "dependency",
        description: `Modify ${directDep.provenance.source} from "${directDep.rawRange}" to compatible range for ${target.version}`,
      });
    } else {
      evidence.push({
        stage: "resolution",
        status: "PASS",
        summary: `Target version ${target.version} satisfies declared range ${directDep.rawRange}`,
        location: directDep.provenance.source,
      });
    }
  }

  // 2. Runtime Environment Compatibility Check
  const runtimeCheck = checkRuntimeCompatibility(model.runtime, target.runtimeRequirement, model.ecosystem);
  if (!runtimeCheck.compatible) {
    const conflict: ConflictReason = {
      category: "runtime_incompatibility",
      severity: "error",
      title: "Runtime Incompatibility",
      message: runtimeCheck.reason ?? `Incompatible runtime requirements.`,
      source: target.runtimeRequirement?.provenance.source ?? model.runtime.provenance.source,
      remediation: `Upgrade the repository runtime environment to satisfy ${target.runtimeRequirement?.range}`,
    };
    conflicts.push(conflict);
    evidence.push({
      stage: "runtime",
      status: "FAIL",
      summary: conflict.message,
      location: model.runtime.provenance.source,
      detail: `Repo: ${runtimeCheck.repoConstraintSummary}, Required by ${target.name}@${target.version}: ${runtimeCheck.packageConstraintSummary}`,
    });
    requiredChanges.push({
      category: "runtime",
      description: `Upgrade runtime constraint in ${model.runtime.provenance.source} to satisfy ${target.runtimeRequirement?.range}`,
    });
  } else if (target.runtimeRequirement) {
    evidence.push({
      stage: "runtime",
      status: "PASS",
      summary: `Runtime requirements satisfied (${target.runtimeRequirement.range ?? "any"})`,
      location: target.runtimeRequirement.provenance.source,
    });
  }

  // 3. Peer Dependencies Declared by Target Package
  const peerDeps = target.dependencies.filter((d) => d.kind === "peer");
  for (const peer of peerDeps) {
    const installedPeer = [...model.dependencies, ...model.devDependencies].find(
      (d) => d.name.toLowerCase() === peer.name.toLowerCase(),
    );

    if (installedPeer) {
      const currentPeerVersion = await adapter.getCurrentVersion(model, peer.name);
      const peerSatisfied = currentPeerVersion
        ? satisfiesVersion(currentPeerVersion, peer.rawRange, model.ecosystem)
        : rangesIntersect(installedPeer.rawRange, peer.rawRange, model.ecosystem);

      if (!peerSatisfied) {
        const conflict: ConflictReason = {
          category: "peer_dependency_unmet",
          severity: peer.optional ? "warning" : "error",
          title: "Peer Dependency Conflict",
          message: `Requires peer "${peer.name} ${peer.rawRange}", but repository has "${currentPeerVersion ?? installedPeer.rawRange}".`,
          source: peer.provenance.source,
          remediation: `Upgrade or adjust ${peer.name} in repository to satisfy "${peer.rawRange}"`,
        };
        if (peer.optional) {
          warnings.push(conflict);
        } else {
          conflicts.push(conflict);
        }
        evidence.push({
          stage: "resolution",
          status: peer.optional ? "WARNING" : "FAIL",
          summary: conflict.message,
          location: peer.provenance.source,
          detail: `Repository has ${installedPeer.name}@${currentPeerVersion ?? installedPeer.rawRange}, needed ${peer.rawRange}`,
        });
        requiredChanges.push({
          category: "dependency",
          description: `Update peer dependency ${peer.name} in repository to satisfy ${peer.rawRange}`,
        });
      }
    } else if (!peer.optional) {
      const conflict: ConflictReason = {
        category: "peer_dependency_unmet",
        severity: "warning",
        title: "Missing Peer Dependency",
        message: `Requires peer dependency "${peer.name} ${peer.rawRange}", which is not declared in the repository.`,
        source: peer.provenance.source,
        remediation: `Install peer dependency ${peer.name}@${peer.rawRange}`,
      };
      warnings.push(conflict);
      evidence.push({
        stage: "resolution",
        status: "WARNING",
        summary: conflict.message,
        location: peer.provenance.source,
      });
    }
  }

  // 4. Inverted Peer Dependencies (Existing dependencies requiring target package as a peer)
  // Check direct dependencies in repository to see if any require the target package as a peer
  for (const dep of model.dependencies) {
    if (dep.name.toLowerCase() === target.name.toLowerCase()) continue;
    const depVersion = await adapter.getCurrentVersion(model, dep.name);
    if (!depVersion) continue;

    try {
      const depMeta = await adapter.fetchPackageVersion(dep.name, depVersion);
      if (!depMeta) continue;

      const peerOnTarget = depMeta.dependencies.find(
        (d) => d.kind === "peer" && d.name.toLowerCase() === target.name.toLowerCase(),
      );

      if (peerOnTarget) {
        const satisfiesInvertedPeer = satisfiesVersion(target.version, peerOnTarget.rawRange, model.ecosystem);
        if (!satisfiesInvertedPeer) {
          const conflict: ConflictReason = {
            category: "inverted_peer_conflict",
            severity: peerOnTarget.optional ? "warning" : "error",
            title: "Inverted Peer Dependency Conflict",
            message: `Installed package "${dep.name}@${depVersion}" requires peer "${target.name} ${peerOnTarget.rawRange}", which rejects target "${target.version}".`,
            source: peerOnTarget.provenance.source,
            remediation: `Upgrade ${dep.name} to a version compatible with ${target.name}@${target.version}`,
          };
          if (peerOnTarget.optional) {
            warnings.push(conflict);
          } else {
            conflicts.push(conflict);
          }
          evidence.push({
            stage: "resolution",
            status: peerOnTarget.optional ? "WARNING" : "FAIL",
            summary: conflict.message,
            location: peerOnTarget.provenance.source,
            detail: `${dep.name}@${depVersion} requires ${target.name} ${peerOnTarget.rawRange}`,
          });
          requiredChanges.push({
            category: "dependency",
            description: `Upgrade ${dep.name} to a version supporting ${target.name}@${target.version}`,
          });
        }
      }
    } catch {
      // Gracefully continue if external metadata fetch fails
    }
  }

  // 5. Shared/Transitive Dependency Incompatibilities (for single-version environments like Python)
  if (model.ecosystem === "python") {
    const runtimeDeps = target.dependencies.filter((d) => d.kind === "runtime");
    for (const dep of runtimeDeps) {
      const existing = model.dependencies.find((d) => d.name.toLowerCase() === dep.name.toLowerCase());
      if (existing) {
        const intersects = rangesIntersect(existing.rawRange, dep.rawRange, model.ecosystem);
        if (!intersects) {
          const conflict: ConflictReason = {
            category: "transitive_conflict",
            severity: "error",
            title: "Shared Dependency Version Conflict",
            message: `Requires "${dep.name} ${dep.rawRange}", but repository pins/declares "${existing.name} ${existing.rawRange}".`,
            source: existing.provenance.source,
            remediation: `Update ${existing.provenance.source} to allow ${dep.rawRange}`,
          };
          conflicts.push(conflict);
          evidence.push({
            stage: "resolution",
            status: "FAIL",
            summary: conflict.message,
            location: existing.provenance.source,
          });
          requiredChanges.push({
            category: "dependency",
            description: `Align ${existing.name} version specifier with ${dep.rawRange}`,
          });
        }
      }
    }
  }

  // 6. Platform Constraints
  if (target.platformRequirement) {
    const reqOs = target.platformRequirement.os;
    if (reqOs && reqOs.length > 0) {
      const currentOs = process.platform;
      const declaredOs = model.platform?.os;
      const matchesOs = declaredOs
        ? declaredOs.some((o) => reqOs.includes(o))
        : reqOs.includes(currentOs);

      if (!matchesOs) {
        const conflict: ConflictReason = {
          category: "platform_unsupported",
          severity: "error",
          title: "Platform OS Incompatibility",
          message: `Package requires OS [${reqOs.join(", ")}], incompatible with repository platform (${declaredOs ? declaredOs.join(", ") : currentOs}).`,
          source: target.platformRequirement.provenance.source,
        };
        conflicts.push(conflict);
        evidence.push({
          stage: "platform",
          status: "FAIL",
          summary: conflict.message,
        });
      }
    }
  }

  // 7. Deprecation / Yanked Status
  if (target.deprecated) {
    const msg = target.deprecationMessage
      ? `Package version is deprecated/yanked: "${target.deprecationMessage}"`
      : `Package version is marked as deprecated or yanked in the registry.`;
    const conflict: ConflictReason = {
      category: "yanked_or_deprecated",
      severity: "warning",
      title: "Package Deprecated / Yanked",
      message: msg,
      source: target.provenance.source,
      remediation: "Select a non-deprecated / non-yanked release if possible.",
    };
    warnings.push(conflict);
    evidence.push({
      stage: "resolution",
      status: "WARNING",
      summary: msg,
      location: target.provenance.source,
    });
  }

  const canCoexist = conflicts.length === 0;
  let verdict: ResolutionAnalysis["verdict"] = "COMPATIBLE";
  if (conflicts.length > 0) {
    verdict = "CANNOT_COEXIST";
  } else if (warnings.length > 0) {
    verdict = "COMPATIBLE_WITH_WARNINGS";
  }

  return {
    packageName: target.name,
    targetVersion: target.version,
    currentVersion,
    canCoexist,
    verdict,
    conflicts,
    warnings,
    requiredChanges,
    evidence,
  };
}

