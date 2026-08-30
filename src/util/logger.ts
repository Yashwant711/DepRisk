/**
 * Minimal structured logger. Categories match section 28 of the spec.
 * Kept dependency-free and simple for MVP; swap for pino/winston later
 * if structured log shipping becomes a requirement.
 */

export type LogCategory =
  | "repository"
  | "metadata"
  | "resolution"
  | "runtime"
  | "build"
  | "source"
  | "tests"
  | "sandbox"
  | "planner"
  | "cli";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function isVerbose(): boolean {
  return verbose;
}

function format(category: LogCategory, message: string): string {
  return `[${category}] ${message}`;
}

export const logger = {
  debug(category: LogCategory, message: string): void {
    if (verbose) {
      // eslint-disable-next-line no-console
      console.error(format(category, message));
    }
  },
  warn(category: LogCategory, message: string): void {
    // eslint-disable-next-line no-console
    console.error(format(category, `WARNING: ${message}`));
  },
  error(category: LogCategory, message: string): void {
    // eslint-disable-next-line no-console
    console.error(format(category, `ERROR: ${message}`));
  },
};
