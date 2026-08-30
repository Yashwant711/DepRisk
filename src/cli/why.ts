import { detectEcosystems } from "../core/registry.js";
import { RepositoryNotSupportedError } from "../core/errors.js";
import { evaluateCompatibility } from "../core/constraint-engine.js";
import { isVerbose, logger } from "../util/logger.js";
import type { PackageVersion } from "../core/model.js";

/**
 * Parses package specifiers like "react@19.0.0", "@types/node@20.0.0", or "react".
 */
export function parsePackageSpec(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const secondAt = trimmed.indexOf("@", 1);
    if (secondAt !== -1) {
      return {
        name: trimmed.slice(0, secondAt),
        version: trimmed.slice(secondAt + 1),
      };
    }
    return { name: trimmed };
  }

  const firstAt = trimmed.indexOf("@");
  if (firstAt !== -1) {
    return {
      name: trimmed.slice(0, firstAt),
      version: trimmed.slice(firstAt + 1),
    };
  }

  return { name: trimmed };
}

export async function runWhy(root: string, packageSpec: string): Promise<void> {
  const detections = await detectEcosystems(root);
  if (detections.length === 0) {
    throw new RepositoryNotSupportedError(root, [
      "package.json (Node.js)",
      "pyproject.toml / requirements.txt / setup.py (Python)",
    ]);
  }

  const best = detections[0];
  const adapter = best.adapter;
  const parsed = parsePackageSpec(packageSpec);

  let targetVersion = parsed.version;
  let targetMeta: PackageVersion | null = null;

  // If no specific version is given, fetch latest stable release
  if (!targetVersion) {
    logger.debug("metadata", `No version specified for ${parsed.name}; querying registry for latest release...`);
    const allVersions = await adapter.fetchPackageVersions(parsed.name);
    if (allVersions.length === 0) {
      console.error(`\nError: Could not find package "${parsed.name}" on the registry.\n`);
      process.exitCode = 1;
      return;
    }
    const stable = allVersions.find((v) => !v.prerelease && !v.deprecated) ?? allVersions[0];
    targetVersion = stable.version;
    targetMeta = stable;
  }

  if (!targetMeta) {
    targetMeta = await adapter.fetchPackageVersion(parsed.name, targetVersion);
  }

  if (!targetMeta) {
    // Fall back to synthesising minimal metadata if registry fetch fails but version was specified
    targetMeta = {
      name: parsed.name,
      version: targetVersion,
      dependencies: [],
      prerelease: /-/.test(targetVersion),
      deprecated: false,
      provenance: { source: `target package input: ${parsed.name}@${targetVersion}` },
    };
  }

  const model = await adapter.buildRepositoryModel(root);
  const analysis = await evaluateCompatibility(model, targetMeta, adapter);

  const lines: string[] = [];
  const ecosystemLabel = model.ecosystem === "node" ? "Node.js" : "Python";

  lines.push("DepRisk — Package Coexistence Analysis\n");
  lines.push(`Target: ${analysis.packageName}@${analysis.targetVersion}`);
  lines.push(`Repository: ${ecosystemLabel} (current: ${analysis.currentVersion ?? "not currently installed"})`);

  if (analysis.verdict === "CANNOT_COEXIST") {
    lines.push(`Verdict: CANNOT COEXIST (${analysis.conflicts.length} conflict${analysis.conflicts.length === 1 ? "" : "s"} found)\n`);
  } else if (analysis.verdict === "COMPATIBLE_WITH_WARNINGS") {
    lines.push(`Verdict: COMPATIBLE WITH WARNINGS (${analysis.warnings.length} warning${analysis.warnings.length === 1 ? "" : "s"})\n`);
  } else {
    lines.push(`Verdict: COMPATIBLE (No conflicts detected)\n`);
  }

  if (analysis.conflicts.length > 0) {
    lines.push("Conflicts preventing selection:");
    analysis.conflicts.forEach((c, idx) => {
      lines.push(`  ${idx + 1}. [${c.title}]`);
      lines.push(`     ${c.message}`);
      if (c.source) {
        lines.push(`     Source: ${c.source}`);
      }
      if (c.remediation) {
        lines.push(`     Fix: ${c.remediation}`);
      }
      lines.push("");
    });
  }

  if (analysis.warnings.length > 0) {
    lines.push("Warnings:");
    analysis.warnings.forEach((w, idx) => {
      lines.push(`  ${idx + 1}. [${w.title}]`);
      lines.push(`     ${w.message}`);
      if (w.source) {
        lines.push(`     Source: ${w.source}`);
      }
      if (w.remediation) {
        lines.push(`     Suggestion: ${w.remediation}`);
      }
      lines.push("");
    });
  }

  if (analysis.requiredChanges.length > 0) {
    lines.push("Required changes to adopt this version:");
    for (const ch of analysis.requiredChanges) {
      lines.push(`  • [${ch.category}] ${ch.description}`);
    }
    lines.push("");
  } else if (analysis.canCoexist) {
    lines.push(`No changes required. ${analysis.packageName}@${analysis.targetVersion} satisfies all current repository constraints.\n`);
  }

  if (isVerbose() && analysis.evidence.length > 0) {
    lines.push("Evidence Trace:");
    for (const ev of analysis.evidence) {
      lines.push(`  [${ev.status}] (${ev.stage}) ${ev.summary}${ev.location ? ` [${ev.location}]` : ""}`);
      if (ev.detail) {
        lines.push(`      ${ev.detail}`);
      }
    }
    lines.push("");
  }

  console.log(lines.join("\n").trimEnd());
}

