/**
 * Core normalized domain model.
 *
 * These types are the contract between the resolver core and every
 * ecosystem adapter (Node, Python, and whatever comes later). Nothing
 * in src/core should import from src/adapters/*, and nothing here should
 * leak ecosystem-specific shapes (npm range syntax, PEP 440 specifiers,
 * etc). Adapters translate INTO this model; the resolver only ever reasons
 * about this model.
 *
 * Per the spec (section 34), we deliberately keep this flexible rather
 * than treating it as final. Fields marked optional are things we may not
 * be able to detect in every repository.
 */

export type Ecosystem = "node" | "python";

/** Where a piece of detected information came from. Critical for explainability (section 22). */
export interface Provenance {
  /** e.g. "package.json:engines.node", "pyproject.toml:requires-python", ".nvmrc" */
  source: string;
  /** Optional raw value as found, before normalization. */
  rawValue?: string;
}

export interface DetectedValue<T> {
  value: T;
  provenance: Provenance;
}

/** A single dependency constraint as declared by a manifest, before resolution. */
export interface DependencyConstraint {
  name: string;
  /** Raw ecosystem-native range string (npm semver range, PEP 440 specifier, etc). */
  rawRange: string;
  kind: "runtime" | "dev" | "peer" | "optional" | "build";
  /** Only present for Python: PEP 508 environment marker, if any. */
  environmentMarker?: string;
  /** Only present for Node: whether this is an optionalDependency / peerDependenciesMeta optional. */
  optional?: boolean;
  provenance: Provenance;
}

export interface RuntimeConstraint {
  /** e.g. "node", "python" */
  name: string;
  /** Normalized range string in the *host* runtime's own semantics is fine here; consumers should use a RuntimeVersion comparator, not string equality. */
  range?: string;
  /** A concrete detected version, if the environment could be introspected (not just declared). */
  detectedVersion?: string;
  provenance: Provenance;
}

export interface PlatformConstraint {
  os?: string[];
  cpu?: string[];
  provenance: Provenance;
}

export interface BuildConfiguration {
  /** Human-readable description of how to build, e.g. "npm run build", "python -m build". */
  buildCommand?: DetectedValue<string>;
  typecheckCommand?: DetectedValue<string>;
  /** Whether the project appears to use a compiled/transpiled language (TypeScript, Cython, etc). */
  requiresCompilation: boolean;
  /** Extra toolchain requirements we noticed (native modules, compilers, etc). Free text for MVP. */
  notes: string[];
}

export interface TestConfiguration {
  testCommand?: DetectedValue<string>;
  testRunner?: string; // "jest" | "vitest" | "pytest" | "unittest" | ...
  detected: boolean;
}

export interface LockState {
  present: boolean;
  /** e.g. "package-lock.json", "poetry.lock", "requirements.txt (pinned)" */
  lockfile?: string;
  /** True if the lockfile appears to fully pin the dependency graph. */
  fullyPinned: boolean;
}

export interface SourceInformation {
  /** Root-relative directories that appear to contain source code. */
  sourceDirs: string[];
  /** Root-relative directories that appear to contain tests. */
  testDirs: string[];
  languageFeatures?: {
    typescript?: boolean;
  };
}

/**
 * The normalized repository model. One instance describes the repository
 * being analyzed, independent of which ecosystem it belongs to.
 */
export interface RepositoryModel {
  root: string;
  ecosystem: Ecosystem;
  packageManager: DetectedValue<string> | null;
  runtime: RuntimeConstraint;
  platform: PlatformConstraint | null;
  dependencies: DependencyConstraint[];
  devDependencies: DependencyConstraint[];
  lockState: LockState;
  buildConfiguration: BuildConfiguration;
  testConfiguration: TestConfiguration;
  sourceInformation: SourceInformation;
  /** Any manifests that were read to build this model, for debugging/--verbose. */
  manifestsRead: string[];
  /** Non-fatal issues encountered while building the model (e.g. malformed but recoverable manifest). */
  warnings: string[];
}

/** A normalized package release, as returned by a registry (npm, PyPI). */
export interface PackageVersion {
  name: string;
  version: string;
  dependencies: DependencyConstraint[];
  runtimeRequirement?: RuntimeConstraint;
  platformRequirement?: PlatformConstraint;
  /** True if the registry marks this as a prerelease / non-stable release. */
  prerelease: boolean;
  /** True if the registry marks this version as deprecated/yanked. */
  deprecated: boolean;
  deprecationMessage?: string;
  publishedAt?: string;
  provenance: Provenance;
}

export type CheckStatus = "PASS" | "WARNING" | "FAIL" | "UNKNOWN";

export interface EvidenceItem {
  /** Which analysis stage produced this evidence. */
  stage:
    | "resolution"
    | "runtime"
    | "platform"
    | "build"
    | "source"
    | "tests";
  status: CheckStatus;
  /** Short human-readable statement, e.g. "Existing code uses an API incompatible with React 19." */
  summary: string;
  /** Optional supporting detail: file, line, command output snippet, etc. */
  location?: string;
  detail?: string;
}

export interface CompatibilityResult {
  packageName: string;
  targetVersion: string;
  overallStatus: CheckStatus;
  /** 0-100. See section 16 — this is a qualitative confidence band represented numerically, not a calibrated probability. */
  confidence: number;
  resolution: CheckStatus;
  runtime: CheckStatus;
  platform: CheckStatus;
  build: CheckStatus;
  source: CheckStatus;
  tests: CheckStatus;
  evidence: EvidenceItem[];
  requiredChanges: RequiredChange[];
  warnings: string[];
}

export interface RequiredChange {
  category: "runtime" | "dependency" | "build" | "configuration" | "source" | "tests";
  description: string;
  affectedFiles?: string[];
  evidence?: EvidenceItem[];
}
