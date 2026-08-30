import type { RepositoryModel } from "../core/model.js";
import { detectEcosystems } from "../core/registry.js";
import { RepositoryNotSupportedError } from "../core/errors.js";
import { isVerbose } from "../util/logger.js";

function formatRuntime(model: RepositoryModel): string {
  const r = model.runtime;
  if (r.detectedVersion) return `${r.detectedVersion} (detected, no explicit constraint)`;
  return `${r.range ?? "unspecified"} (source: ${r.provenance.source})`;
}

export async function runInspect(root: string): Promise<void> {
  const detections = await detectEcosystems(root);
  if (detections.length === 0) {
    throw new RepositoryNotSupportedError(root, [
      "package.json (Node.js)",
      "pyproject.toml / requirements.txt / setup.py (Python)",
    ]);
  }

  const best = detections[0];
  const model = await best.adapter.buildRepositoryModel(root);

  const ecosystemLabel = model.ecosystem === "node" ? "Node.js" : "Python";
  const lines: string[] = [];

  lines.push("DepRisk — Repository Inspection\n");
  lines.push("Repository");
  lines.push(`  ecosystem: ${ecosystemLabel}`);
  lines.push(`  package manager: ${model.packageManager?.value ?? "unknown"}`);
  lines.push(`  runtime: ${formatRuntime(model)}`);
  lines.push(`  lockfile: ${model.lockState.present ? model.lockState.lockfile : "none detected"}`);
  lines.push(`  build: ${model.buildConfiguration.buildCommand?.value ?? "not detected"}`);
  lines.push(`  tests: ${model.testConfiguration.testCommand?.value ?? "not detected"}`);
  if (model.sourceInformation.languageFeatures?.typescript) {
    lines.push(`  typescript: yes`);
  }
  lines.push("");
  lines.push("Dependencies");
  lines.push(`  production: ${model.dependencies.filter((d) => d.kind === "runtime").length}`);
  lines.push(`  development: ${model.devDependencies.length}`);
  const peers = model.dependencies.filter((d) => d.kind === "peer").length;
  const optional = model.dependencies.filter((d) => d.kind === "optional").length;
  if (peers > 0) lines.push(`  peer: ${peers}`);
  if (optional > 0) lines.push(`  optional: ${optional}`);

  if (detections.length > 1) {
    lines.push("");
    lines.push(
      `Note: multiple ecosystems detected (${detections.map((d) => d.adapter.ecosystem).join(", ")}). ` +
        `Using ${best.adapter.ecosystem} (${best.reason}). Multi-ecosystem repos are not fully supported yet.`,
    );
  }

  if (model.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings");
    for (const w of model.warnings) lines.push(`  ${w}`);
  }

  if (isVerbose()) {
    lines.push("");
    lines.push("Manifests read");
    for (const m of model.manifestsRead) lines.push(`  ${m}`);
    lines.push("");
    lines.push("Dependency detail");
    for (const d of [...model.dependencies, ...model.devDependencies]) {
      lines.push(`  ${d.name} ${d.rawRange} [${d.kind}] (${d.provenance.source})`);
    }
  }

  console.log(lines.join("\n"));
}
