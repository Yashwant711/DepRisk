#!/usr/bin/env node
import { Command } from "commander";
import { runInspect } from "./inspect.js";
import { runWhy } from "./why.js";
import { runVersions } from "./versions.js";
import { runCheck } from "./check.js";
import { runChanges } from "./changes.js";
import { setVerbose } from "../util/logger.js";
import { RepositoryNotSupportedError, NotImplementedError } from "../core/errors.js";

const program = new Command();

program
  .name("deprisk")
  .description("Repository-aware dependency compatibility analysis for Node.js and Python.")
  .version("0.1.0")
  .option("-v, --verbose", "print debug/verbose output", false)
  .option("-C, --dir <path>", "repository root to analyze", ".")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    setVerbose(Boolean(opts.verbose));
  });

program
  .command("inspect")
  .description("Show DepRisk's normalized understanding of the current repository")
  .action(async () => {
    const opts = program.opts();
    await runInspect(opts.dir);
  });

program
  .command("check <package>")
  .description("Check whether upgrading <package> (optionally @<version>) is likely safe")
  .option("--skip-install", "skip package installation and only run static checks", false)
  .option("--skip-build", "skip build and typecheck steps", false)
  .option("--skip-tests", "skip automated test execution", false)
  .option("--timeout <ms>", "timeout in milliseconds for commands", (v) => parseInt(v, 10))
  .action(async (pkg: string, commandOpts: { skipInstall?: boolean; skipBuild?: boolean; skipTests?: boolean; timeout?: number }) => {
    const opts = program.opts();
    await runCheck(opts.dir, pkg, commandOpts);
  });

program
  .command("versions <package>")
  .description("List versions of <package> compatible with this repository")
  .option("--major <n>", "restrict to a specific major version")
  .option("--range <range>", "restrict to versions matching a range")
  .option("--all", "display all matching versions without truncation", false)
  .action(async (pkg: string, commandOpts: { major?: string; range?: string; all?: boolean }) => {
    const opts = program.opts();
    await runVersions(opts.dir, pkg, commandOpts);
  });

program
  .command("changes <package>")
  .description("Explain what must change to adopt <package>@<version>")
  .action(async (pkg: string) => {
    const opts = program.opts();
    await runChanges(opts.dir, pkg);
  });

program
  .command("why <package>")
  .description("Explain why <package>@<version> cannot currently be selected")
  .action(async (pkg: string) => {
    const opts = program.opts();
    await runWhy(opts.dir, pkg);
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof RepositoryNotSupportedError || err instanceof NotImplementedError) {
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    console.error("\nUnexpected error:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  }
}

main();
