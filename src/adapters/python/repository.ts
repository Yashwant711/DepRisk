import path from "node:path";
import * as TOML from "@iarna/toml";
import type {
  BuildConfiguration,
  DependencyConstraint,
  LockState,
  RepositoryModel,
  RuntimeConstraint,
  SourceInformation,
  TestConfiguration,
} from "../../core/model.js";
import { fileExists, readTextFile } from "../../util/fs.js";
import { logger } from "../../util/logger.js";

interface PyProjectToml {
  project?: {
    name?: string;
    version?: string;
    "requires-python"?: string;
    dependencies?: string[];
    "optional-dependencies"?: Record<string, string[]>;
  };
  tool?: {
    poetry?: {
      dependencies?: Record<string, string | { version?: string }>;
      group?: Record<string, { dependencies?: Record<string, string | { version?: string }> }>;
    };
  };
  "build-system"?: { "build-backend"?: string; requires?: string[] };
}

export interface PythonDetection {
  matches: boolean;
  confidence: number;
  reason: string;
}

export async function detectPython(root: string): Promise<PythonDetection> {
  const hasPyproject = await fileExists(root, "pyproject.toml");
  const hasRequirements = await fileExists(root, "requirements.txt");
  const hasSetupPy = await fileExists(root, "setup.py");

  if (hasPyproject) {
    return { matches: true, confidence: 1, reason: "pyproject.toml present" };
  }
  if (hasRequirements) {
    return { matches: true, confidence: 0.8, reason: "requirements.txt present" };
  }
  if (hasSetupPy) {
    return { matches: true, confidence: 0.6, reason: "setup.py present (legacy packaging)" };
  }
  return { matches: false, confidence: 0, reason: "no pyproject.toml, requirements.txt, or setup.py found" };
}

/**
 * Parses a single PEP 508-ish requirement line into name + specifier.
 * Deliberately conservative: handles the common cases (name, extras,
 * version specifiers, environment markers) and falls back to treating
 * the whole line as an opaque name if it can't confidently parse it.
 */
function parseRequirementLine(line: string): { name: string; rawRange: string; environmentMarker?: string } | null {
  const trimmed = line.split("#")[0].trim();
  if (!trimmed || trimmed.startsWith("-")) return null; // skip options like -r, --index-url, comments

  const [reqPart, markerPart] = trimmed.split(";").map((s) => s.trim());
  const match = reqPart.match(/^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  const [, name, , specifier] = match;
  return {
    name,
    rawRange: specifier || "*",
    environmentMarker: markerPart || undefined,
  };
}

async function parseRequirementsTxt(root: string, source: string): Promise<DependencyConstraint[]> {
  const text = await readTextFile(root, source);
  if (!text) return [];
  const constraints: DependencyConstraint[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseRequirementLine(line);
    if (!parsed) continue;
    constraints.push({
      name: parsed.name,
      rawRange: parsed.rawRange,
      kind: "runtime",
      environmentMarker: parsed.environmentMarker,
      provenance: { source: `${source}:${parsed.name}`, rawValue: line.trim() },
    });
  }
  return constraints;
}

function poetryDepsToConstraints(
  deps: Record<string, string | { version?: string }> | undefined,
  kind: DependencyConstraint["kind"],
  groupLabel: string,
): DependencyConstraint[] {
  if (!deps) return [];
  return Object.entries(deps)
    .filter(([name]) => name.toLowerCase() !== "python") // python itself is a runtime constraint, not a dependency
    .map(([name, spec]) => {
      const rawRange = typeof spec === "string" ? spec : spec.version ?? "*";
      return {
        name,
        rawRange,
        kind,
        provenance: { source: `pyproject.toml:${groupLabel}.${name}`, rawValue: rawRange },
      };
    });
}

async function parsePyprojectDependencies(
  root: string,
  doc: PyProjectToml,
): Promise<{ dependencies: DependencyConstraint[]; devDependencies: DependencyConstraint[]; runtime: RuntimeConstraint | null }> {
  const dependencies: DependencyConstraint[] = [];
  const devDependencies: DependencyConstraint[] = [];
  let runtime: RuntimeConstraint | null = null;

  if (doc.project?.["requires-python"]) {
    runtime = {
      name: "python",
      range: doc.project["requires-python"],
      provenance: { source: "pyproject.toml:project.requires-python", rawValue: doc.project["requires-python"] },
    };
  }

  if (doc.project?.dependencies) {
    for (const line of doc.project.dependencies) {
      const parsed = parseRequirementLine(line);
      if (!parsed) continue;
      dependencies.push({
        name: parsed.name,
        rawRange: parsed.rawRange,
        kind: "runtime",
        environmentMarker: parsed.environmentMarker,
        provenance: { source: "pyproject.toml:project.dependencies", rawValue: line },
      });
    }
  }

  for (const [group, deps] of Object.entries(doc.project?.["optional-dependencies"] ?? {})) {
    for (const line of deps) {
      const parsed = parseRequirementLine(line);
      if (!parsed) continue;
      devDependencies.push({
        name: parsed.name,
        rawRange: parsed.rawRange,
        kind: "optional",
        environmentMarker: parsed.environmentMarker,
        provenance: { source: `pyproject.toml:project.optional-dependencies.${group}`, rawValue: line },
      });
    }
  }

  // Poetry-style declarations (legacy [tool.poetry] format, still very common).
  if (doc.tool?.poetry) {
    const poetryDeps = doc.tool.poetry.dependencies ?? {};
    if (typeof poetryDeps.python === "string" && !runtime) {
      runtime = {
        name: "python",
        range: poetryDeps.python,
        provenance: { source: "pyproject.toml:tool.poetry.dependencies.python", rawValue: poetryDeps.python },
      };
    }
    dependencies.push(...poetryDepsToConstraints(poetryDeps, "runtime", "tool.poetry.dependencies"));
    for (const [groupName, group] of Object.entries(doc.tool.poetry.group ?? {})) {
      devDependencies.push(...poetryDepsToConstraints(group.dependencies, "dev", `tool.poetry.group.${groupName}.dependencies`));
    }
  }

  return { dependencies, devDependencies, runtime };
}

async function detectRuntime(root: string, pyprojectRuntime: RuntimeConstraint | null): Promise<RuntimeConstraint> {
  if (pyprojectRuntime) return pyprojectRuntime;

  const pythonVersionFile = await readTextFile(root, ".python-version");
  if (pythonVersionFile) {
    return {
      name: "python",
      range: pythonVersionFile.trim(),
      provenance: { source: ".python-version", rawValue: pythonVersionFile.trim() },
    };
  }

  return {
    name: "python",
    provenance: { source: "no explicit constraint declared" },
  };
}

async function detectLockState(root: string): Promise<LockState> {
  if (await fileExists(root, "poetry.lock")) {
    return { present: true, lockfile: "poetry.lock", fullyPinned: true };
  }
  if (await fileExists(root, "uv.lock")) {
    return { present: true, lockfile: "uv.lock", fullyPinned: true };
  }
  if (await fileExists(root, "requirements.txt")) {
    // requirements.txt is only "fully pinned" if every line uses ==; we don't know yet without parsing,
    // so we conservatively report it as present but not guaranteed pinned.
    return { present: true, lockfile: "requirements.txt", fullyPinned: false };
  }
  return { present: false, fullyPinned: false };
}

async function detectBuildConfiguration(root: string, doc: PyProjectToml | null): Promise<BuildConfiguration> {
  const notes: string[] = [];
  const backend = doc?.["build-system"]?.["build-backend"];
  if (backend) notes.push(`build backend: ${backend}`);

  return {
    buildCommand: backend ? { value: "python -m build", provenance: { source: "pyproject.toml:build-system", rawValue: backend } } : undefined,
    typecheckCommand: (await fileExists(root, "mypy.ini")) || (await fileExists(root, "setup.cfg"))
      ? { value: "mypy .", provenance: { source: "mypy.ini or setup.cfg present" } }
      : undefined,
    requiresCompilation: false,
    notes,
  };
}

async function detectTestConfiguration(root: string): Promise<TestConfiguration> {
  const hasPytestIni = await fileExists(root, "pytest.ini");
  const hasConftest = await fileExists(root, "conftest.py");
  const hasTestsDir = (await fileExists(root, "tests")) || (await fileExists(root, "test"));

  if (hasPytestIni || hasConftest || hasTestsDir) {
    return {
      detected: true,
      testCommand: { value: "pytest", provenance: { source: hasPytestIni ? "pytest.ini" : hasConftest ? "conftest.py" : "tests/ directory" } },
      testRunner: "pytest",
    };
  }
  return { detected: false };
}

async function detectSourceInformation(root: string): Promise<SourceInformation> {
  const sourceDirs: string[] = [];
  const testDirs: string[] = [];
  for (const dir of ["src", "app"]) {
    if (await fileExists(root, dir)) sourceDirs.push(dir);
  }
  for (const dir of ["tests", "test"]) {
    if (await fileExists(root, dir)) testDirs.push(dir);
  }
  return { sourceDirs: sourceDirs.length ? sourceDirs : ["."], testDirs };
}

export async function buildPythonRepositoryModel(root: string): Promise<RepositoryModel> {
  const warnings: string[] = [];
  const manifestsRead: string[] = [];

  let doc: PyProjectToml | null = null;
  const pyprojectText = await readTextFile(root, "pyproject.toml");
  if (pyprojectText) {
    manifestsRead.push("pyproject.toml");
    try {
      doc = TOML.parse(pyprojectText) as PyProjectToml;
    } catch (err) {
      warnings.push(`pyproject.toml could not be parsed: ${(err as Error).message}`);
    }
  }

  const { dependencies: pyprojectDeps, devDependencies: pyprojectDevDeps, runtime: pyprojectRuntime } = doc
    ? await parsePyprojectDependencies(root, doc)
    : { dependencies: [], devDependencies: [], runtime: null };

  let dependencies = pyprojectDeps;
  let devDependencies = pyprojectDevDeps;

  if (dependencies.length === 0 && (await fileExists(root, "requirements.txt"))) {
    manifestsRead.push("requirements.txt");
    dependencies = await parseRequirementsTxt(root, "requirements.txt");
  }
  if (await fileExists(root, "requirements-dev.txt")) {
    manifestsRead.push("requirements-dev.txt");
    devDependencies = [...devDependencies, ...(await parseRequirementsTxt(root, "requirements-dev.txt"))];
  }

  const runtime = await detectRuntime(root, pyprojectRuntime);
  const lockState = await detectLockState(root);
  const buildConfiguration = await detectBuildConfiguration(root, doc);
  const testConfiguration = await detectTestConfiguration(root);
  const sourceInformation = await detectSourceInformation(root);

  logger.debug("repository", `Python repository model built at ${path.resolve(root)} (${dependencies.length} deps, ${devDependencies.length} devDeps)`);

  return {
    root: path.resolve(root),
    ecosystem: "python",
    packageManager: {
      value: (await fileExists(root, "poetry.lock")) ? "poetry" : (await fileExists(root, "uv.lock")) ? "uv" : "pip",
      provenance: { source: lockState.lockfile ?? "default (no lockfile detected)" },
    },
    runtime,
    platform: null,
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
