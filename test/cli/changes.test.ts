import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChanges } from "../../src/cli/changes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("CLI changes command", () => {
  it("generates a migration plan for react@19.0.0 on node-basic fixture", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runChanges(NODE_FIXTURE, "react@19.0.0");
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("DepRisk — Migration & Change Plan");
    expect(output).toContain("Target: react@19.0.0");
    expect(output).toContain("Plan Overview:");
    expect(output).toContain("Step-by-Step Migration Guide:");
    expect(output).toContain("Update Package Dependencies");
    expect(output).toContain("npm install react@^19.0.0");
  });

  it("generates a migration plan for fastapi@0.111.0 on python-basic fixture", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runChanges(PYTHON_FIXTURE, "fastapi@0.111.0");
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("DepRisk — Migration & Change Plan");
    expect(output).toContain("Target: fastapi@0.111.0");
    expect(output).toContain("Step-by-Step Migration Guide:");
    expect(output).toContain("pip install fastapi==0.111.0");
  });
});

