import path from "node:path";
import type {
  BuildConfiguration,
  DependencyConstraint,
  LockState,
  RepositoryModel,
  RuntimeConstraint,
  SourceInformation,
  TestConfiguration,
} from "../../core/model.js";
import { fileExists, readJsonFile, readTextFile } from "../../util/fs.js";
import { logger } from "../../util/logger.js";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  scripts?: Record<string, string>;
  packageManager?: string; // corepack field, e.g. "pnpm@8.6.0"
}

export interface NodeDetection {
  matches: boolean;
  confidence: number;
  reason: string;
}

export async function detectNode(root: string): Promise<NodeDetection> {
  const hasPackageJson = await fileExists(root, "package.json");
  if (!hasPackageJson) {
    return { matches: false, confidence: 0, reason: "no package.json found" };
  }
  const hasLock = await fileExists(root, "package-lock.json");
  return {
    matches: true,
    confidence: hasLock ? 1 : 0.8,
    reason: hasLock
      ? "package.json and package-lock.json present"
      : "package.json present (no npm lockfile found)",
  };
}

function toConstraints(
  deps: Record<string, string> | undefined,
  kind: DependencyConstraint["kind"],
  source: string,
  peerOptionalSet?: Set<string>,
): DependencyConstraint[] {
  if (!deps) return [];
  return Object.entries(deps).map(([name, rawRange]) => ({
    name,
    rawRange,
    kind,
    optional: peerOptionalSet?.has(name) ?? undefined,
    provenance: { source: `${source}:${kind === "runtime" ? "dependencies" : kind}.${name}`, rawValue: rawRange },
  }));
}

async function detectPackageManager(root: string, pkg: PackageJson): Promise<{ name: string; source: string } > {
  if (pkg.packageManager) {
    const [name] = pkg.packageManager.split("@");
    return { name, source: "package.json:packageManager" };
  }
  if (await fileExists(root, "package-lock.json")) return { name: "npm", source: "package-lock.json" };
  if (await fileExists(root, "pnpm-lock.yaml")) return { name: "pnpm", source: "pnpm-lock.yaml" };
  if (await fileExists(root, "yarn.lock")) return { name: "yarn", source: "yarn.lock" };
  return { name: "npm", source: "default (no lockfile detected)" };
}

async function detectRuntime(root: string, pkg: PackageJson): Promise<RuntimeConstraint> {
  const nvmrc = await readTextFile(root, ".nvmrc");
  if (nvmrc) {
    return {
      name: "node",
      range: nvmrc.trim(),
      provenance: { source: ".nvmrc", rawValue: nvmrc.trim() },
    };
  }
  if (pkg.engines?.node) {
    return {
      name: "node",
      range: pkg.engines.node,
      provenance: { source: "package.json:engines.node", rawValue: pkg.engines.node },
    };
  }
  return {
    name: "node",
    detectedVersion: process.version.replace(/^v/, ""),
    provenance: { source: "host process (no explicit constraint declared)", rawValue: process.version },
  };
}

async function detectLockState(root: string): Promise<LockState> {
  if (await fileExists(root, "package-lock.json")) {
    return { present: true, lockfile: "package-lock.json", fullyPinned: true };
  }
  if (await fileExists(root, "pnpm-lock.yaml")) {
    return { present: true, lockfile: "pnpm-lock.yaml", fullyPinned: true };
  }
  if (await fileExists(root, "yarn.lock")) {
    return { present: true, lockfile: "yarn.lock", fullyPinned: true };
  }
  return { present: false, fullyPinned: false };
}

async function detectBuildConfiguration(root: string, pkg: PackageJson): Promise<BuildConfiguration> {
  const notes: string[] = [];
  const hasTsconfig = await fileExists(root, "tsconfig.json");
  const buildScript = pkg.scripts?.build;
  const typecheckScript =
    pkg.scripts?.typecheck ?? (hasTsconfig && pkg.scripts?.["type-check"]) ?? undefined;

  if (hasTsconfig) notes.push("tsconfig.json present: project appears to use TypeScript");

  return {
    buildCommand: buildScript
      ? { value: `npm run build`, provenance: { source: "package.json:scripts.build", rawValue: buildScript } }
      : undefined,
    typecheckCommand: typecheckScript
      ? { value: `npm run typecheck`, provenance: { source: "package.json:scripts.typecheck", rawValue: typecheckScript } }
      : undefined,
    requiresCompilation: hasTsconfig,
    notes,
  };
}

function detectTestConfiguration(pkg: PackageJson): TestConfiguration {
  const testScript = pkg.scripts?.test;
  if (!testScript || /no test specified/i.test(testScript)) {
    return { detected: false };
  }
  let runner: string | undefined;
  if (/jest/.test(testScript)) runner = "jest";
  else if (/vitest/.test(testScript)) runner = "vitest";
  else if (/mocha/.test(testScript)) runner = "mocha";
  else if (/ava\b/.test(testScript)) runner = "ava";

  return {
    detected: true,
    testCommand: { value: "npm test", provenance: { source: "package.json:scripts.test", rawValue: testScript } },
    testRunner: runner,
  };
}

async function detectSourceInformation(root: string, hasTsconfig: boolean): Promise<SourceInformation> {
  const sourceDirs: string[] = [];
  const testDirs: string[] = [];
  for (const dir of ["src", "lib", "app"]) {
    if (await fileExists(root, dir)) sourceDirs.push(dir);
  }
  for (const dir of ["test", "tests", "__tests__", "spec"]) {
    if (await fileExists(root, dir)) testDirs.push(dir);
  }
  return {
    sourceDirs: sourceDirs.length ? sourceDirs : ["."],
    testDirs,
    languageFeatures: { typescript: hasTsconfig },
  };
}

export async function buildNodeRepositoryModel(root: string): Promise<RepositoryModel> {
  const warnings: string[] = [];
  const manifestsRead: string[] = ["package.json"];

  const pkg = (await readJsonFile<PackageJson>(root, "package.json")) ?? {};
  if (Object.keys(pkg).length === 0) {
    warnings.push("package.json could not be parsed; proceeding with an empty manifest");
  }

  const packageManager = await detectPackageManager(root, pkg);
  const runtime = await detectRuntime(root, pkg);
  const lockState = await detectLockState(root);
  if (lockState.present) manifestsRead.push(lockState.lockfile!);
  const buildConfiguration = await detectBuildConfiguration(root, pkg);
  const testConfiguration = detectTestConfiguration(pkg);
  const sourceInformation = await detectSourceInformation(root, buildConfiguration.requiresCompilation);

  const peerOptional = new Set(
    Object.entries(pkg.peerDependenciesMeta ?? {})
      .filter(([, v]) => v.optional)
      .map(([name]) => name),
  );

  const dependencies: DependencyConstraint[] = [
    ...toConstraints(pkg.dependencies, "runtime", "package.json"),
    ...toConstraints(pkg.peerDependencies, "peer", "package.json", peerOptional),
    ...toConstraints(pkg.optionalDependencies, "optional", "package.json"),
  ];
  const devDependencies: DependencyConstraint[] = toConstraints(pkg.devDependencies, "dev", "package.json");

  logger.debug("repository", `Node repository model built at ${path.resolve(root)} (${dependencies.length} deps, ${devDependencies.length} devDeps)`);

  return {
    root: path.resolve(root),
    ecosystem: "node",
    packageManager: { value: packageManager.name, provenance: { source: packageManager.source } },
    runtime,
    platform:
      pkg.os || pkg.cpu
        ? { os: pkg.os, cpu: pkg.cpu, provenance: { source: "package.json:os/cpu" } }
        : null,
    dependencies,
    devDependencies,
    lockState,
    buildConfiguration,
    testConfiguration,
    sourceInformation,
    manifestsRead,
    warnings,
  };
}
