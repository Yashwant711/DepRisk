import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../../src/cli/check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("CLI check command", () => {
  it("runs single-version verification for react@18.2.0 on node-basic fixture (skipInstall)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runCheck(NODE_FIXTURE, "react@18.2.0", { skipInstall: true });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Target: react@18.2.0");
    expect(output).toContain("Verdict: PASS (Likely Safe)");
    expect(output).toContain("Verification Pipeline:");
    expect(output).toContain("Resolution & Dependencies");
  });

  it("runs single-version verification for react@19.0.0 on node-basic fixture (skipInstall)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runCheck(NODE_FIXTURE, "react@19.0.0", { skipInstall: true });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Target: react@19.0.0");
    expect(output).toContain("Verdict: FAIL (Incompatible / Broken)");
    expect(output).toContain("Failures & Concrete Evidence:");
  });

  it("runs upgrade safety analysis for react on node-basic fixture (skipInstall)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runCheck(NODE_FIXTURE, "react", { skipInstall: true });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("DepRisk — Upgrade Safety Analysis");
    expect(output).toContain("Package: react");
    expect(output).toContain("Upgrade Candidates Evaluated");
    expect(output).toContain("Recommendation:");
  });

  it("runs upgrade safety analysis for requests on python-basic fixture (skipInstall)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runCheck(PYTHON_FIXTURE, "requests", { skipInstall: true });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("DepRisk — Upgrade Safety Analysis");
    expect(output).toContain("Package: requests");
    expect(output).toContain("Upgrade Candidates Evaluated");
    expect(output).toContain("Recommendation:");
  });
});
