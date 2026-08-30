import path from "node:path";
import fg from "fast-glob";
import type { PackageAdapter } from "./adapter.js";
import type {
  Ecosystem,
  PackageVersion,
  RepositoryModel,
} from "./model.js";
import { evaluateCompatibility } from "./constraint-engine.js";
import { readTextFile } from "../util/fs.js";
import { logger } from "../util/logger.js";

export interface MigrationStep {
  stepNumber: number;
  title: string;
  category: "runtime" | "dependency" | "source" | "configuration" | "verification";
  instructions: string[];
  command?: string;
  files?: string[];
}

export interface MigrationPlan {
  packageName: string;
  targetVersion: string;
  currentVersion: string | null;
  declaredRange: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  runtimeChanges: Array<{ current: string; required: string; description: string }>;
  dependencyChanges: Array<{ package: string; currentRange?: string; targetRange: string; reason: string }>;
  installCommand: string;
  affectedSourceFiles: string[];
  configurationChanges: string[];
  verificationCommands: string[];
  steps: MigrationStep[];
}

/**
 * Scans repository source directories for files importing or referencing the package.
 */
export async function findAffectedSourceFiles(
  repoRoot: string,
  sourceDirs: string[],
  packageName: string,
  ecosystem: Ecosystem,
): Promise<string[]> {
  const extensions = ecosystem === "node" ? ["ts", "tsx", "js", "jsx", "mjs", "cjs"] : ["py"];
  const extGlob = extensions.length === 1 ? `*.${extensions[0]}` : `*.{${extensions.join(",")}}`;
  const patterns = sourceDirs.map((dir) =>
    path.posix.join(dir === "." ? "" : dir, `**/${extGlob}`),
  );

  let files: string[] = [];
  try {
    files = await fg(patterns, { cwd: repoRoot, ignore: ["node_modules/**", "dist/**", ".venv/**", "venv/**"] });
  } catch (err) {
    logger.debug("source", `Glob search failed: ${(err as Error).message}`);
    return [];
  }

  const affected: string[] = [];

  // Match import statements
  const nodeImportRegex = new RegExp(
    `(from\\s+['"]${packageName}(?:\\/.*)?['"]|require\\(['"]${packageName}(?:\\/.*)?['"]\\)|import\\(['"]${packageName}(?:\\/.*)?['"]\\))`,
  );
  const pythonImportRegex = new RegExp(
    `(from\\s+${packageName}(?:\\..*)?\\s+import|import\\s+${packageName}(?:\\..*)?)`,
  );

  const regex = ecosystem === "node" ? nodeImportRegex : pythonImportRegex;

  for (const relFile of files) {
    const content = await readTextFile(repoRoot, relFile);
    if (content && regex.test(content)) {
      affected.push(path.normalize(relFile));
    }
  }

  return affected;
}

/**
 * Generates an actionable, step-by-step migration plan to adopt a target package version.
 */
export async function planMigration(
  model: RepositoryModel,
  target: PackageVersion,
  adapter: PackageAdapter,
): Promise<MigrationPlan> {
  const currentVersion = await adapter.getCurrentVersion(model, target.name);
  const directDep = [...model.dependencies, ...model.devDependencies].find(
    (d) => d.name.toLowerCase() === target.name.toLowerCase(),
  );
  const declaredRange = directDep?.rawRange ?? null;

  // 1. Static compatibility analysis
  const staticCheck = await evaluateCompatibility(model, target, adapter);

  // 2. Scan affected source files
  const affectedSourceFiles = await findAffectedSourceFiles(
    model.root,
    model.sourceInformation.sourceDirs,
    target.name,
    model.ecosystem,
  );

  // 3. Runtime Changes
  const runtimeChanges: MigrationPlan["runtimeChanges"] = [];
  const runtimeConflict = staticCheck.conflicts.find((c) => c.category === "runtime_incompatibility");
  if (runtimeConflict && target.runtimeRequirement?.range) {
    const current = model.runtime.range ?? model.runtime.detectedVersion ?? "unspecified";
    runtimeChanges.push({
      current,
      required: target.runtimeRequirement.range,
      description: `Update ${model.runtime.provenance.source} runtime constraint from "${current}" to "${target.runtimeRequirement.range}"`,
    });
  }

  // 4. Dependency Changes (Target Package + Peer Co-upgrades)
  const dependencyChanges: MigrationPlan["dependencyChanges"] = [];
  const targetDepRange = model.ecosystem === "node" ? `^${target.version}` : `==${target.version}`;

  dependencyChanges.push({
    package: target.name,
    currentRange: declaredRange ?? undefined,
    targetRange: targetDepRange,
    reason: `Adopt target version ${target.version}`,
  });

  // Check peer-dependent packages in repo that must co-upgrade (e.g. react-dom with react)
  for (const dep of model.dependencies) {
    if (dep.name.toLowerCase() === target.name.toLowerCase()) continue;
    const depVer = await adapter.getCurrentVersion(model, dep.name);
    if (!depVer) continue;
    try {
      const depMeta = await adapter.fetchPackageVersion(dep.name, depVer);
      if (depMeta) {
        const peerOnTarget = depMeta.dependencies.find(
          (d) => d.kind === "peer" && d.name.toLowerCase() === target.name.toLowerCase(),
        );
        if (peerOnTarget) {
          // If current peer requirement conflicts with target version, it needs co-upgrade
          const coUpgradeRange = model.ecosystem === "node" ? `^${target.version}` : `==${target.version}`;
          dependencyChanges.push({
            package: dep.name,
            currentRange: dep.rawRange,
            targetRange: coUpgradeRange,
            reason: `Co-upgrade peer-dependent package with ${target.name}@${target.version}`,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // Check new required peer dependencies from target
  for (const peer of target.dependencies.filter((d) => d.kind === "peer" && !d.optional)) {
    const inRepo = [...model.dependencies, ...model.devDependencies].some(
      (d) => d.name.toLowerCase() === peer.name.toLowerCase(),
    );
    if (!inRepo) {
      dependencyChanges.push({
        package: peer.name,
        targetRange: peer.rawRange,
        reason: `New required peer dependency for ${target.name}@${target.version}`,
      });
    }
  }

  // 5. Generate package manager install command
  let installCommand = "";
  if (model.ecosystem === "node") {
    const pkgManager = model.packageManager?.value ?? "npm";
    const addCmd = pkgManager === "yarn" ? "add" : "install";
    const specs = dependencyChanges.map((d) => `${d.package}@${d.targetRange}`).join(" ");
    installCommand = `${pkgManager} ${addCmd} ${specs}`;
  } else {
    const specs = dependencyChanges.map((d) => `${d.package}${d.targetRange}`).join(" ");
    installCommand = `pip install ${specs}`;
  }

  // 6. Configuration Changes
  const configurationChanges: string[] = [];
  if (model.buildConfiguration.requiresCompilation) {
    configurationChanges.push("Verify tsconfig.json compiler target and moduleResolution settings are compatible.");
  }

  // 7. Verification Commands
  const verificationCommands: string[] = [];
  if (model.buildConfiguration.buildCommand) {
    verificationCommands.push(model.buildConfiguration.buildCommand.value);
  }
  if (model.buildConfiguration.typecheckCommand) {
    verificationCommands.push(model.buildConfiguration.typecheckCommand.value);
  }
  if (model.testConfiguration.testCommand) {
    verificationCommands.push(model.testConfiguration.testCommand.value);
  }

  // 8. Build Ordered Steps
  const steps: MigrationStep[] = [];
  let stepIdx = 1;

  if (runtimeChanges.length > 0) {
    steps.push({
      stepNumber: stepIdx++,
      title: "Update Runtime Environment Constraints",
      category: "runtime",
      instructions: runtimeChanges.map((r) => r.description),
    });
  }

  steps.push({
    stepNumber: stepIdx++,
    title: "Update Package Dependencies",
    category: "dependency",
    instructions: [
      `Update manifest to adopt ${target.name}@${targetDepRange}`,
      ...dependencyChanges.slice(1).map((d) => `Co-upgrade ${d.package} (${d.reason})`),
    ],
    command: installCommand,
  });

  if (configurationChanges.length > 0) {
    steps.push({
      stepNumber: stepIdx++,
      title: "Review Build and Tooling Configuration",
      category: "configuration",
      instructions: configurationChanges,
    });
  }

  if (affectedSourceFiles.length > 0) {
    steps.push({
      stepNumber: stepIdx++,
      title: "Review Affected Source Code & API Usage",
      category: "source",
      instructions: [
        `Review ${affectedSourceFiles.length} file(s) that import ${target.name} for breaking API changes or deprecated methods.`,
      ],
      files: affectedSourceFiles,
    });
  }

  if (verificationCommands.length > 0) {
    steps.push({
      stepNumber: stepIdx++,
      title: "Run Verification and Automated Tests",
      category: "verification",
      instructions: verificationCommands.map((cmd) => `Execute \`${cmd}\` to confirm build integrity and tests pass.`),
      command: verificationCommands.join(" && "),
    });
  }

  // Risk Level
  let riskLevel: MigrationPlan["riskLevel"] = "LOW";
  if (runtimeChanges.length > 0 || dependencyChanges.length > 2) {
    riskLevel = "HIGH";
  } else if (affectedSourceFiles.length > 5 || dependencyChanges.length > 1) {
    riskLevel = "MEDIUM";
  }

  return {
    packageName: target.name,
    targetVersion: target.version,
    currentVersion,
    declaredRange,
    riskLevel,
    runtimeChanges,
    dependencyChanges,
    installCommand,
    affectedSourceFiles,
    configurationChanges,
    verificationCommands,
    steps,
  };
}
