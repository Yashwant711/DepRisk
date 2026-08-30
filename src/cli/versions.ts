import { detectEcosystems } from "../core/registry.js";
import { RepositoryNotSupportedError } from "../core/errors.js";
import { discoverCompatibleVersions } from "../core/version-discovery.js";
import { isVerbose, logger } from "../util/logger.js";
import { parsePackageSpec } from "./why.js";

export interface VersionsCliOptions {
  major?: string;
  range?: string;
  all?: boolean;
}

export async function runVersions(
  root: string,
  packageSpec: string,
  options: VersionsCliOptions = {},
): Promise<void> {
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
  const packageName = parsed.name;

  logger.debug("metadata", `Fetching published versions for ${packageName}...`);
  const allVersions = await adapter.fetchPackageVersions(packageName);
  if (allVersions.length === 0) {
    console.error(`\nError: Could not find package "${packageName}" on the registry.\n`);
    process.exitCode = 1;
    return;
  }

  const model = await adapter.buildRepositoryModel(root);
  const discovery = await discoverCompatibleVersions(model, allVersions, adapter, {
    major: options.major,
    range: options.range,
  });

  const ecosystemLabel = model.ecosystem === "node" ? "Node.js" : "Python";
  const lines: string[] = [];

  lines.push("DepRisk — Compatible Version Discovery\n");
  lines.push(`Package: ${packageName}`);
  lines.push(
    `Repository: ${ecosystemLabel} (current: ${discovery.currentVersion ?? "not installed"}${
      discovery.declaredRange ? `, manifest range: "${discovery.declaredRange}"` : ""
    })`,
  );

  if (options.major) lines.push(`Filter: major ${options.major}`);
  if (options.range) lines.push(`Filter: range "${options.range}"`);
  lines.push("");

  // Compatible Versions Section
  if (discovery.compatible.length > 0) {
    lines.push(`Compatible Versions (${discovery.compatible.length}):`);
    if (discovery.latestCompatible) {
      lines.push(`  ★ Latest Compatible: ${discovery.latestCompatible.version}`);
      lines.push("");
    }

    const displayLimit = options.all || isVerbose() ? discovery.compatible.length : 15;
    const shown = discovery.compatible.slice(0, displayLimit);

    for (const v of shown) {
      const tags: string[] = [];
      if (v.satisfiesCurrentManifest) tags.push("current range");
      else tags.push("adoptable");
      if (v.deprecated) tags.push("deprecated");

      lines.push(`  • ${v.version} [${tags.join(", ")}]`);
    }

    if (discovery.compatible.length > displayLimit) {
      lines.push(`  ... and ${discovery.compatible.length - displayLimit} more compatible versions (use -v or --all to view all)`);
    }
  } else {
    lines.push("Compatible Versions (0):");
    lines.push("  No compatible versions found matching current repository constraints.");
  }

  lines.push("");

  // Incompatible Versions Section
  if (discovery.incompatible.length > 0) {
    lines.push(`Incompatible Versions (${discovery.incompatible.length}):`);
    const displayLimit = options.all || isVerbose() ? discovery.incompatible.length : 10;
    const shown = discovery.incompatible.slice(0, displayLimit);

    for (const v of shown) {
      const reasonStr = v.reasons.length > 0 ? v.reasons.join("; ") : "rejected by repository constraints";
      lines.push(`  ✕ ${v.version} — ${reasonStr}`);
    }

    if (discovery.incompatible.length > displayLimit) {
      lines.push(`  ... and ${discovery.incompatible.length - displayLimit} more incompatible versions`);
    }
    lines.push("");
  }

  // Summary
  lines.push(
    `Summary: ${discovery.compatible.length} compatible, ${discovery.incompatible.length} incompatible out of ${discovery.totalChecked} version(s) evaluated.`,
  );

  console.log(lines.join("\n"));
}

