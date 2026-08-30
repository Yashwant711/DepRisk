import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function runCommand(commandLine: string, options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    logger.debug("sandbox", `Running: "${commandLine}" in ${options.cwd ?? process.cwd()}`);

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const proc = spawn(commandLine, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, ...options.env },
    });

    let stdout = "";
    let stderr = "";

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        logger.debug("sandbox", `Command timed out after ${timeoutMs}ms: "${commandLine}"`);
        proc.kill("SIGTERM");
      }, timeoutMs);
    }

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: stderr + (err.message ? `\n${err.message}` : ""),
        timedOut: false,
      });
    });
  });
}
