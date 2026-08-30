import type { PackageAdapter } from "./adapter.js";
import type {
  CheckStatus,
  CompatibilityResult,
  EvidenceItem,
  PackageVersion,
  RepositoryModel,
  RequiredChange,
} from "./model.js";
import { evaluateCompatibility } from "./constraint-engine.js";
import { createIsolatedEnvironment } from "./environment.js";
import { runCommand } from "../util/exec.js";
import { logger } from "../util/logger.js";

export interface VerificationOptions {
  skipInstall?: boolean;
  skipBuild?: boolean;
  skipTests?: boolean;
  timeoutMs?: number;
}

function extractSnippet(text: string, maxLines = 8): string {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

/**
 * Runs full single-version compatibility verification in an isolated environment.
 */
export async function verifyPackageVersion(
  model: RepositoryModel,
  target: PackageVersion,
  adapter: PackageAdapter,
  options: VerificationOptions = {},
): Promise<CompatibilityResult> {
  const warnings: string[] = [];
  const requiredChanges: RequiredChange[] = [];
  const evidence: EvidenceItem[] = [];

  // Stage 1: Static Constraint Analysis
  const staticAnalysis = await evaluateCompatibility(model, target, adapter);
  evidence.push(...staticAnalysis.evidence);
  requiredChanges.push(...staticAnalysis.requiredChanges);

  for (const w of staticAnalysis.warnings) {
    warnings.push(w.message);
  }

  let resolution: CheckStatus = "PASS";
  let runtime: CheckStatus = "PASS";
  let platform: CheckStatus = "PASS";
  let build: CheckStatus = model.buildConfiguration.buildCommand ? "UNKNOWN" : "PASS";
  let source: CheckStatus = model.buildConfiguration.typecheckCommand ? "UNKNOWN" : "PASS";
  let tests: CheckStatus = model.testConfiguration.testCommand ? "UNKNOWN" : "PASS";

  const hasResolutionConflict = staticAnalysis.conflicts.some((c) =>
    ["direct_range", "peer_dependency_unmet", "inverted_peer_conflict", "transitive_conflict"].includes(c.category),
  );
  if (hasResolutionConflict) {
    resolution = "FAIL";
  } else if (staticAnalysis.warnings.some((w) => w.category === "peer_dependency_unmet")) {
    resolution = "WARNING";
  }

  if (staticAnalysis.conflicts.some((c) => c.category === "runtime_incompatibility")) {
    runtime = "FAIL";
  }

  if (staticAnalysis.conflicts.some((c) => c.category === "platform_unsupported")) {
    platform = "FAIL";
  }

  // If runtime is incompatible, active verification is skipped
  if (runtime === "FAIL") {
    return assembleResult({
      target,
      resolution,
      runtime,
      platform,
      build: "UNKNOWN",
      source: "UNKNOWN",
      tests: "UNKNOWN",
      evidence,
      requiredChanges,
      warnings,
      hasTests: Boolean(model.testConfiguration.testCommand),
      hasBuild: Boolean(model.buildConfiguration.buildCommand),
    });
  }

  // Stage 2: Isolated Sandbox Verification
  if (!options.skipInstall) {
    let env;
    try {
      env = await createIsolatedEnvironment(model.root, model.ecosystem);
      await env.patchManifest(target.name, target.version);

      logger.debug("sandbox", `Installing ${target.name}@${target.version} in sandbox...`);
      const installRes = await env.install({ timeoutMs: options.timeoutMs });

      if (installRes.code !== 0) {
        resolution = "FAIL";
        const snippet = extractSnippet(installRes.stderr || installRes.stdout);
        evidence.push({
          stage: "resolution",
          status: "FAIL",
          summary: `Package installation failed in sandbox (exit code ${installRes.code})`,
          detail: snippet,
        });
        return assembleResult({
          target,
          resolution,
          runtime,
          platform,
          build: "UNKNOWN",
          source: "UNKNOWN",
          tests: "UNKNOWN",
          evidence,
          requiredChanges,
          warnings,
          hasTests: Boolean(model.testConfiguration.testCommand),
          hasBuild: Boolean(model.buildConfiguration.buildCommand),
        });
      }

      evidence.push({
        stage: "resolution",
        status: "PASS",
        summary: `Successfully installed ${target.name}@${target.version} in isolated environment`,
      });

      // Step 2b: Build Verification
      if (!options.skipBuild && model.buildConfiguration.buildCommand) {
        const buildCmd = model.buildConfiguration.buildCommand.value;
        logger.debug("build", `Running build command: ${buildCmd}`);
        const buildRes = await runCommand(buildCmd, { cwd: env.dir, timeoutMs: options.timeoutMs });

        if (buildRes.code === 0) {
          build = "PASS";
          evidence.push({
            stage: "build",
            status: "PASS",
            summary: `Build passed (${buildCmd})`,
          });
        } else {
          build = "FAIL";
          const snippet = extractSnippet(buildRes.stderr || buildRes.stdout);
          evidence.push({
            stage: "build",
            status: "FAIL",
            summary: `Build failed (${buildCmd})`,
            detail: snippet,
          });
          requiredChanges.push({
            category: "build",
            description: `Fix build errors triggered by ${target.name}@${target.version}`,
          });
        }
      }

      // Step 2c: Typecheck Verification
      if (!options.skipBuild && model.buildConfiguration.typecheckCommand) {
        const typeCmd = model.buildConfiguration.typecheckCommand.value;
        logger.debug("source", `Running typecheck command: ${typeCmd}`);
        const typeRes = await runCommand(typeCmd, { cwd: env.dir, timeoutMs: options.timeoutMs });

        if (typeRes.code === 0) {
          source = "PASS";
          evidence.push({
            stage: "source",
            status: "PASS",
            summary: `Type-check passed (${typeCmd})`,
          });
        } else {
          source = "FAIL";
          const snippet = extractSnippet(typeRes.stderr || typeRes.stdout);
          evidence.push({
            stage: "source",
            status: "FAIL",
            summary: `Type-check failed (${typeCmd})`,
            detail: snippet,
          });
          requiredChanges.push({
            category: "source",
            description: `Resolve TypeScript/typecheck errors with ${target.name}@${target.version}`,
          });
        }
      }

      // Step 2d: Test Verification
      if (!options.skipTests && model.testConfiguration.testCommand) {
        const testCmd = model.testConfiguration.testCommand.value;
        logger.debug("tests", `Running test suite: ${testCmd}`);
        const testRes = await runCommand(testCmd, { cwd: env.dir, timeoutMs: options.timeoutMs });

        if (testRes.code === 0) {
          tests = "PASS";
          evidence.push({
            stage: "tests",
            status: "PASS",
            summary: `Automated tests passed (${testCmd})`,
          });
        } else {
          tests = "FAIL";
          const snippet = extractSnippet(testRes.stderr || testRes.stdout);
          evidence.push({
            stage: "tests",
            status: "FAIL",
            summary: `Test suite failed (${testCmd})`,
            detail: snippet,
          });
          requiredChanges.push({
            category: "tests",
            description: `Fix failing test cases after upgrading ${target.name}@${target.version}`,
          });
        }
      }
    } catch (err) {
      logger.debug("sandbox", `Sandbox verification error: ${(err as Error).message}`);
    } finally {
      if (env) {
        await env.cleanup();
      }
    }
  }

  return assembleResult({
    target,
    resolution,
    runtime,
    platform,
    build,
    source,
    tests,
    evidence,
    requiredChanges,
    warnings,
    hasTests: Boolean(model.testConfiguration.testCommand),
    hasBuild: Boolean(model.buildConfiguration.buildCommand),
  });
}

interface AssemblyContext {
  target: PackageVersion;
  resolution: CheckStatus;
  runtime: CheckStatus;
  platform: CheckStatus;
  build: CheckStatus;
  source: CheckStatus;
  tests: CheckStatus;
  evidence: EvidenceItem[];
  requiredChanges: RequiredChange[];
  warnings: string[];
  hasTests: boolean;
  hasBuild: boolean;
}

function assembleResult(ctx: AssemblyContext): CompatibilityResult {
  const hasFailures = [ctx.resolution, ctx.runtime, ctx.platform, ctx.build, ctx.source, ctx.tests].includes("FAIL");
  const hasWarnings = [ctx.resolution, ctx.runtime, ctx.platform, ctx.build, ctx.source, ctx.tests].includes("WARNING") || ctx.warnings.length > 0;

  let overallStatus: CheckStatus = "PASS";
  if (hasFailures) {
    overallStatus = "FAIL";
  } else if (hasWarnings) {
    overallStatus = "WARNING";
  }

  let confidence = 70;
  if (overallStatus === "FAIL") {
    confidence = 90;
  } else if (overallStatus === "PASS") {
    if (ctx.tests === "PASS" && ctx.build === "PASS") {
      confidence = 95;
    } else if (ctx.tests === "PASS") {
      confidence = 90;
    } else if (ctx.build === "PASS") {
      confidence = 80;
    } else {
      confidence = 70;
    }
  } else {
    confidence = 65;
  }

  return {
    packageName: ctx.target.name,
    targetVersion: ctx.target.version,
    overallStatus,
    confidence,
    resolution: ctx.resolution,
    runtime: ctx.runtime,
    platform: ctx.platform,
    build: ctx.build,
    source: ctx.source,
    tests: ctx.tests,
    evidence: ctx.evidence,
    requiredChanges: ctx.requiredChanges,
    warnings: ctx.warnings,
  };
}
