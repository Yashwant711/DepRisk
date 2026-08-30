import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVersions } from "../../src/cli/versions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("CLI versions command", () => {
  it("runs version discovery for react against node-basic fixture", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runVersions(NODE_FIXTURE, "react", { major: "18" });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Package: react");
    expect(output).toContain("Filter: major 18");
    expect(output).toContain("Compatible Versions");
    expect(output).toContain("Summary:");
  });

  it("runs version discovery for requests against python-basic fixture", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg);
    });

    await runVersions(PYTHON_FIXTURE, "requests", { range: ">=2.30.0" });
    spy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Package: requests");
    expect(output).toContain('Filter: range ">=2.30.0"');
    expect(output).toContain("Compatible Versions");
  });
});

