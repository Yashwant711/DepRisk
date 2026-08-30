import { detectEcosystems } from "../core/registry.js";
import { RepositoryNotSupportedError } from "../core/errors.js";
import { planMigration } from "../core/migration-planner.js";
import { logger } from "../util/logger.js";
import { parsePackageSpec } from "./why.js";
import type { PackageVersion } from "../core/model.js";

export async function runChanges(root: string, packageSpec: string): Promise<void> {
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
  const plan = await planMigration(model, targetMeta, adapter);

  const lines: string[] = [];
  const ecosystemLabel = model.ecosystem === "node" ? "Node.js" : "Python";

  lines.push("DepRisk — Migration & Change Plan\n");
  lines.push(`Target: ${plan.packageName}@${plan.targetVersion}`);
  lines.push(
    `Repository: ${ecosystemLabel} (current: ${plan.currentVersion ?? "not installed"}${
      plan.declaredRange ? `, manifest range: "${plan.declaredRange}"` : ""
    })`,
  );
  lines.push(`Migration Risk: ${plan.riskLevel}\n`);

  lines.push("Plan Overview:");
  lines.push(`  • Dependency changes: ${plan.dependencyChanges.length} package(s)`);
  if (plan.runtimeChanges.length > 0) {
    lines.push(`  • Runtime adjustments required: ${plan.runtimeChanges.length}`);
  }
  lines.push(`  • Affected source files: ${plan.affectedSourceFiles.length} file(s) identified`);
  lines.push("");

  lines.push("Step-by-Step Migration Guide:\n");

  for (const step of plan.steps) {
    lines.push(`${step.stepNumber}. [${step.title}]`);
    for (const inst of step.instructions) {
      lines.push(`   • ${inst}`);
    }
    if (step.command) {
      lines.push(`   Command:`);
      lines.push(`     $ ${step.command}`);
    }
    if (step.files && step.files.length > 0) {
      lines.push(`   Files to inspect:`);
      for (const f of step.files) {
        lines.push(`     - ${f}`);
      }
    }
    lines.push("");
  }

  console.log(lines.join("\n").trimEnd());
}

