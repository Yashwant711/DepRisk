# DepRisk

**Repository-Aware Dependency Compatibility Analysis for Node.js and Python.**

DepRisk evaluates package upgrades and dependencies within the **real context of your repository**—including declared runtime engines, lockfiles, peer dependencies, build toolchains, type systems, automated test suites, and source code usages—rather than evaluating versions in isolation.

---

## Features

- 🔍 **Repository Inspection (`inspect`)**: Normalizes repo metadata across Node.js (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `.nvmrc`, `tsconfig.json`) and Python (`pyproject.toml`, `requirements.txt`, `poetry.lock`, `uv.lock`, `.python-version`, `pytest.ini`).
- 🛑 **Constraint & Conflict Explanations (`why`)**: Diagnoses why a target package version cannot coexist with the current dependency graph (manifest range conflicts, runtime mismatches, peer conflicts, inverted peer requirements, and platform constraints).
- 🧭 **Compatible Version Discovery (`versions`)**: Queries npm/PyPI to find and rank all compatible versions for a package matching your repo constraints, with support for `--major` and `--range` filters.
- 🧪 **Single-Version Verification & Upgrade Safety (`check`)**:
  - **With `@version`**: Clones repo into a safe isolated sandbox, patches manifests, installs the target package, executes build/typecheck/test commands, and outputs a confidence-scored verification matrix.
  - **Without `@version`**: Discovers candidate upgrade tiers (Patch, Minor, Next Major, Latest) and recommends the safest upgrade path.
- 📋 **Step-by-Step Migration Plans (`changes`)**: Scans source code for affected imports and generates an actionable, step-by-step migration guide with concrete shell commands.
- ⚡ **High Performance & Safety**: In-memory registry metadata caching with TTL and automatic sandbox lifecycle cleanup hooks.

---

## Supported Ecosystems

| Ecosystem | Manifests & Lockfiles | Runtime Declarations | Build & Test Tooling |
| :--- | :--- | :--- | :--- |
| **Node.js** | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | `engines.node`, `.nvmrc`, host process | `tsc`, TypeScript, npm scripts, Jest, Vitest, Mocha, Ava |
| **Python** | `pyproject.toml` (PEP 621 & Poetry), `requirements.txt`, `poetry.lock`, `uv.lock` | `project.requires-python`, `tool.poetry.dependencies.python`, `.python-version` | `python -m build`, `mypy`, `pytest` |

---

## Installation & Setup

### Prerequisites
- Node.js (v18.0.0 or higher)
- npm

### 1. Clone & Install Dependencies
```bash
git clone <repo-url> deprisk
cd deprisk
npm install
```

### 2. Build TypeScript
```bash
npm run build
```

### 3. Run Tests
```bash
npm test
```

---

## CLI Reference & Usage

DepRisk can be executed in development mode via `npm run dev -- <command>` or by linking/running `node dist/cli/index.js <command>`.

### Global Options

```text
Options:
  -V, --version       Output version number
  -v, --verbose       Print debug logs, provenance sources, and full evidence traces
  -C, --dir <path>    Specify repository root directory to analyze (default: ".")
  -h, --help          Display help for commands
```

---

### 1. `deprisk inspect`
Shows DepRisk's normalized model of the target repository.

```bash
# Inspect current repository
npm run dev -- inspect

# Inspect another repository directory
npm run dev -- inspect -C /path/to/project

# Verbose output (displays detected manifests and full dependency lists)
npm run dev -- inspect -C /path/to/project -v
```

#### Example Output:
```text
DepRisk — Repository Inspection

Repository
  ecosystem: Node.js
  package manager: npm
  runtime: >=18 (source: package.json:engines.node)
  lockfile: package-lock.json
  build: npm run build
  tests: npm test
  typescript: yes

Dependencies
  production: 2
  development: 1
```

---

### 2. `deprisk why <package>@<version>`
Explains why a specific package version cannot coexist with the current repository graph and environment constraints.

```bash
# Check why React 19 cannot currently be adopted
npm run dev -- why react@19.0.0 -C /path/to/project

# Check Python package compatibility
npm run dev -- why fastapi@0.95.0 -C /path/to/python-project
```

#### Example Output:
```text
DepRisk — Package Coexistence Analysis

Target: react@19.0.0
Repository: Node.js (current: 18.2.0)
Verdict: CANNOT COEXIST (1 conflict found)

Conflicts preventing selection:
  1. [Direct Dependency Range Mismatch]
     Declared range "^18.2.0" rejects target version "19.0.0".
     Source: package.json:dependencies.react
     Fix: Update declared range in package.json:dependencies.react to include "19.0.0" (e.g. ^19.0.0 or ==19.0.0)

Required changes to adopt this version:
  • [dependency] Modify package.json:dependencies.react from "^18.2.0" to compatible range for 19.0.0
```

---

### 3. `deprisk versions <package>`
Discovers and lists all published versions of `<package>` from the registry that are compatible with the repository's runtime, platform, and peer dependencies.

```bash
# Discover all compatible versions of react
npm run dev -- versions react

# Restrict to a specific major version
npm run dev -- versions react --major 18

# Restrict to a semver / PEP 440 range
npm run dev -- versions requests --range ">=2.30.0"

# Show all matching versions without pagination
npm run dev -- versions react --all
```

#### Options:
- `--major <n>`: Restrict discovery to a specific major version (e.g. `18`, `2`).
- `--range <range>`: Restrict discovery to a custom range (e.g. `"^18.0.0"`, `">=2.30.0"`).
- `--all`: Show all compatible versions without truncation.

#### Example Output:
```text
DepRisk — Compatible Version Discovery

Package: react
Repository: Node.js (current: 18.2.0, manifest range: "^18.2.0")
Filter: major 18

Compatible Versions (5):
  ★ Latest Compatible: 18.3.1

  • 18.3.1 [current range]
  • 18.3.0 [current range]
  • 18.2.0 [current range]
  • 18.1.0 [adoptable]
  • 18.0.0 [adoptable]

Summary: 5 compatible, 0 incompatible out of 5 version(s) evaluated.
```

---

### 4. `deprisk check <package>` / `deprisk check <package>@<version>`
Performs single-version sandbox verification or automatic upgrade safety analysis.

#### A. Single-Version Verification (`deprisk check <package>@<version>`)
Creates an isolated sandbox in a temporary directory, patches the target manifest, installs the package, and executes build, typecheck, and test commands to produce a verified verdict.

```bash
# Verify react@18.3.1
npm run dev -- check react@18.3.1

# Verify with fast static checks (skip installation)
npm run dev -- check react@19.0.0 --skip-install

# Options: --skip-build, --skip-tests, --timeout <ms>
npm run dev -- check requests@2.31.0 --skip-tests --timeout 30000
```

#### Example Output:
```text
DepRisk — Single-Version Verification

Target: react@18.2.0
Repository: Node.js (current: 18.2.0)
Verdict: PASS (Likely Safe)
Confidence: 95%

Verification Pipeline:
  [PASS]      Resolution & Dependencies
  [PASS]      Runtime Environment
  [PASS]      Platform Compatibility
  [PASS]      Build & Compilation
  [PASS]      Source & Typecheck
  [PASS]      Automated Tests

Upgrade is clean. All checks passed with no required manual adjustments.
```

#### B. Upgrade Safety Analysis (`deprisk check <package>`)
When no version tag is provided, DepRisk discovers candidate upgrade releases (Latest Patch, Latest In-Major Minor, Next Major, Latest Overall), compares them against the current repo state, and recommends the safest upgrade path.

```bash
npm run dev -- check react
npm run dev -- check requests -C /path/to/python-project
```

#### Example Output:
```text
DepRisk — Upgrade Safety Analysis

Package: react
Repository: Node.js (current: 18.2.0, manifest range: "^18.2.0")

Upgrade Candidates Evaluated (2):
  • 18.3.1 (Latest Minor (In-Major))
    Verdict: PASS (95% confidence) ★ RECOMMENDED
    Status: Safe in-major upgrade — no breaking changes detected

  • 19.0.8 (Next Major (19.x))
    Verdict: FAIL (90% confidence)
    Status: Declared range "^18.2.0" rejects target version "19.0.8".
    Reason: Declared range "^18.2.0" rejects target version "19.0.8".

Recommendation:
  ★ Safest Upgrade: react@18.3.1 (Latest Minor (In-Major))
    Confidence: 95%
    Action: update package.json to ^18.3.1 and run npm install
```

---

### 5. `deprisk changes <package>@<version>`
Scans repository source files for import usages and generates a step-by-step migration guide for adopting the target package version.

```bash
# Generate migration plan for React 19
npm run dev -- changes react@19.0.0

# Generate migration plan for FastAPI
npm run dev -- changes fastapi@0.111.0 -C /path/to/python-project
```

#### Example Output:
```text
DepRisk — Migration & Change Plan

Target: react@19.0.0
Repository: Node.js (current: 18.2.0, manifest range: "^18.2.0")
Migration Risk: LOW

Plan Overview:
  • Dependency changes: 1 package(s)
  • Affected source files: 1 file(s) identified

Step-by-Step Migration Guide:

1. [Update Package Dependencies]
   • Update manifest to adopt react@^19.0.0
   Command:
     $ npm install react@^19.0.0

2. [Review Build and Tooling Configuration]
   • Verify tsconfig.json compiler target and moduleResolution settings are compatible.

3. [Review Affected Source Code & API Usage]
   • Review 1 file(s) that import react for breaking API changes or deprecated methods.
   Files to inspect:
     - src/index.ts

4. [Run Verification and Automated Tests]
   • Execute `npm run build` to confirm build integrity and tests pass.
   • Execute `npm test` to confirm build integrity and tests pass.
   Command:
     $ npm run build && npm test
```

---

## Project Architecture

```
deprisk/
├── src/
│   ├── cli/
│   │   ├── index.ts          # CLI commander entry point & argument routing
│   │   ├── inspect.ts        # inspect command runner
│   │   ├── why.ts            # why command runner
│   │   ├── versions.ts       # versions command runner
│   │   ├── check.ts          # check command runner (single-version & upgrade safety)
│   │   └── changes.ts        # changes command runner (migration planner)
│   ├── core/
│   │   ├── model.ts          # Core domain models & normalized RepositoryModel
│   │   ├── adapter.ts        # PackageAdapter interface contract
│   │   ├── registry.ts       # Adapter registration & ecosystem auto-detection
│   │   ├── pep440.ts         # PEP 440 parser, comparator, & specifier matcher
│   │   ├── version-matcher.ts# Unified Semver & PEP 440 compatibility engine
│   │   ├── constraint-engine.ts # Core multi-stage conflict analysis engine
│   │   ├── version-discovery.ts # Compatible version discovery & filter engine
│   │   ├── environment.ts    # Isolated sandbox manager with process exit hooks
│   │   ├── verifier.ts       # Active verification pipeline (install/build/test)
│   │   ├── upgrade-analyzer.ts  # Upgrade candidate discovery & recommendation
│   │   ├── migration-planner.ts # Source code scanner & migration step generator
│   │   └── errors.ts         # Domain error definitions
│   ├── adapters/
│   │   ├── node/             # Node.js repository parser & npm registry adapter
│   │   └── python/           # Python repository parser & PyPI registry adapter
│   └── util/
│       ├── cache.ts          # MemoryCache with TTL for network queries
│       ├── exec.ts           # Child process execution helper
│       ├── fs.ts             # File and directory manipulation utilities
│       └── logger.ts         # Structured log handler
└── test/
    ├── core/                 # Unit tests for core engines
    ├── cli/                  # Integration tests for CLI commands
    ├── adapters/             # Adapter unit tests
    ├── integration/          # End-to-end integration tests
    └── fixtures/             # Deterministic Node & Python test repositories
```

---

## Testing

Run the test suite with Vitest:
```bash
npm test
```

Watch mode for development:
```bash
npm run test:watch
```

---

## License

ISC

