import { detectEcosystems } from "../core/registry.js";
import { RepositoryNotSupportedError } from "../core/errors.js";
import { verifyPackageVersion } from "../core/verifier.js";
import { analyzeUpgradeSafety } from "../core/upgrade-analyzer.js";
import { isVerbose, logger } from "../util/logger.js";
import { parsePackageSpec } from "./why.js";
import type { CheckStatus, PackageVersion } from "../core/model.js";

export interface CheckCliOptions {
  skipInstall?: boolean;
  skipBuild?: boolean;
  skipTests?: boolean;
  timeout?: number;
}

function formatStatusTag(status: CheckStatus): string {
  switch (status) {
    case "PASS":
      return "[PASS]";
    case "FAIL":
      return "[FAIL]";
    case "WARNING":
      return "[WARNING]";
    case "UNKNOWN":
      return "[SKIPPED]";
  }
}

export async function runCheck(
  root: string,
  packageSpec: string,
  options: CheckCliOptions = {},
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
  const model = await adapter.buildRepositoryModel(root);
  const ecosystemLabel = model.ecosystem === "node" ? "Node.js" : "Python";

  // CASE 1: Upgrade Safety Analysis (No explicit @version specified)
  if (!parsed.version) {
    logger.debug("resolution", `Running upgrade safety analysis for ${parsed.name}...`);
    const analysis = await analyzeUpgradeSafety(model, parsed.name, adapter, {
      skipInstall: options.skipInstall,
      skipBuild: options.skipBuild,
      skipTests: options.skipTests,
      timeoutMs: options.timeout,
    });

    const lines: string[] = [];
    lines.push("DepRisk — Upgrade Safety Analysis\n");
    lines.push(`Package: ${analysis.packageName}`);
    lines.push(
      `Repository: ${ecosystemLabel} (current: ${analysis.currentVersion ?? "not installed"}${
        analysis.declaredRange ? `, manifest range: "${analysis.declaredRange}"` : ""
      })\n`,
    );

    if (analysis.isAlreadyLatest) {
      lines.push(`Status: ${analysis.message}\n`);
      console.log(lines.join("\n").trimEnd());
      return;
    }

    if (analysis.candidates.length === 0) {
      lines.push(`No upgrade candidates found: ${analysis.message}\n`);
      console.log(lines.join("\n").trimEnd());
      return;
    }

    lines.push(`Upgrade Candidates Evaluated (${analysis.candidates.length}):`);
    for (const evalItem of analysis.candidates) {
      const isRecommended = analysis.recommendedUpgrade?.candidate.version.version === evalItem.candidate.version.version;
      const recBadge = isRecommended ? " ★ RECOMMENDED" : "";

      lines.push(`  • ${evalItem.candidate.version.version} (${evalItem.candidate.tierLabel})`);
      lines.push(`    Verdict: ${evalItem.result.overallStatus} (${evalItem.result.confidence}% confidence)${recBadge}`);
      lines.push(`    Status: ${evalItem.summary}`);

      if (evalItem.result.overallStatus === "FAIL") {
        const firstFail = evalItem.result.evidence.find((e) => e.status === "FAIL");
        if (firstFail) {
          lines.push(`    Reason: ${firstFail.summary}`);
        }
      }
      lines.push("");
    }

    if (analysis.recommendedUpgrade) {
      const rec = analysis.recommendedUpgrade;
      lines.push("Recommendation:");
      lines.push(`  ★ Safest Upgrade: ${analysis.packageName}@${rec.candidate.version.version} (${rec.candidate.tierLabel})`);
      lines.push(`    Confidence: ${rec.result.confidence}%`);

      if (model.ecosystem === "node") {
        lines.push(`    Action: update package.json to ^${rec.candidate.version.version} and run npm install`);
      } else {
        lines.push(`    Action: update pyproject.toml / requirements.txt to ==${rec.candidate.version.version}`);
      }
    } else {
      lines.push("Recommendation:");
      lines.push("  ✕ No automated upgrade is fully safe. Address blocking conflicts before upgrading.");
    }

    console.log(lines.join("\n").trimEnd());
    return;
  }

  // CASE 2: Single-Version Verification (Explicit @version specified)
  const targetVersion = parsed.version;
  let targetMeta = await adapter.fetchPackageVersion(parsed.name, targetVersion);

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

  const currentVersion = await adapter.getCurrentVersion(model, parsed.name);
  const result = await verifyPackageVersion(model, targetMeta, adapter, {
    skipInstall: options.skipInstall,
    skipBuild: options.skipBuild,
    skipTests: options.skipTests,
    timeoutMs: options.timeout,
  });

  const lines: string[] = [];

  lines.push("DepRisk — Single-Version Verification\n");
  lines.push(`Target: ${result.packageName}@${result.targetVersion}`);
  lines.push(`Repository: ${ecosystemLabel} (current: ${currentVersion ?? "not installed"})`);

  let verdictLabel = "PASS (Likely Safe)";
  if (result.overallStatus === "FAIL") {
    verdictLabel = "FAIL (Incompatible / Broken)";
  } else if (result.overallStatus === "WARNING") {
    verdictLabel = "WARNING (Proceed with Caution)";
  }

  lines.push(`Verdict: ${verdictLabel}`);
  lines.push(`Confidence: ${result.confidence}%\n`);

  lines.push("Verification Pipeline:");
  lines.push(`  ${formatStatusTag(result.resolution).padEnd(11)} Resolution & Dependencies`);
  lines.push(`  ${formatStatusTag(result.runtime).padEnd(11)} Runtime Environment`);
  lines.push(`  ${formatStatusTag(result.platform).padEnd(11)} Platform Compatibility`);
  lines.push(`  ${formatStatusTag(result.build).padEnd(11)} Build & Compilation`);
  lines.push(`  ${formatStatusTag(result.source).padEnd(11)} Source & Typecheck`);
  lines.push(`  ${formatStatusTag(result.tests).padEnd(11)} Automated Tests`);
  lines.push("");

  const failureEvidence = result.evidence.filter((e) => e.status === "FAIL");
  if (failureEvidence.length > 0) {
    lines.push("Failures & Concrete Evidence:");
    for (const ev of failureEvidence) {
      lines.push(`  [FAIL] (${ev.stage}) ${ev.summary}${ev.location ? ` [${ev.location}]` : ""}`);
      if (ev.detail) {
        const indent = "      ";
        const indented = ev.detail
          .split("\n")
          .map((l) => `${indent}${l}`)
          .join("\n");
        lines.push(indented);
      }
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.warnings) {
      lines.push(`  • ${w}`);
    }
    lines.push("");
  }

  if (result.requiredChanges.length > 0) {
    lines.push("Required Changes to Adopt:");
    for (const ch of result.requiredChanges) {
      lines.push(`  • [${ch.category}] ${ch.description}`);
    }
    lines.push("");
  } else if (result.overallStatus === "PASS") {
    lines.push(`Upgrade is clean. All checks passed with no required manual adjustments.\n`);
  }

  if (isVerbose() && result.evidence.length > 0) {
    lines.push("Full Evidence Log:");
    for (const ev of result.evidence) {
      lines.push(`  ${formatStatusTag(ev.status)} (${ev.stage}) ${ev.summary}`);
    }
    lines.push("");
  }

  console.log(lines.join("\n").trimEnd());
}
