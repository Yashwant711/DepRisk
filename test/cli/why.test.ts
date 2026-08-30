import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageSpec, runWhy } from "../../src/cli/why.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURE = path.join(__dirname, "..", "fixtures", "node-basic");
const PYTHON_FIXTURE = path.join(__dirname, "..", "fixtures", "python-basic");

describe("CLI why command", () => {
  describe("parsePackageSpec", () => {
    it("parses unscoped packages with and without version", () => {
      expect(parsePackageSpec("react@19.0.0")).toEqual({ name: "react", version: "19.0.0" });
      expect(parsePackageSpec("react")).toEqual({ name: "react" });
      expect(parsePackageSpec("fastapi@0.95.0")).toEqual({ name: "fastapi", version: "0.95.0" });
    });

    it("parses scoped packages with and without version", () => {
      expect(parsePackageSpec("@types/node@20.0.0")).toEqual({ name: "@types/node", version: "20.0.0" });
      expect(parsePackageSpec("@types/node")).toEqual({ name: "@types/node" });
      expect(parsePackageSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
    });
  });

  describe("runWhy integration with fixtures", () => {
    it("explains why react@19.0.0 cannot coexist with fixture-node-basic (manifest mismatch)", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });

      await runWhy(NODE_FIXTURE, "react@19.0.0");
      spy.mockRestore();

      const output = logs.join("\n");
      expect(output).toContain("Target: react@19.0.0");
      expect(output).toContain("Verdict: CANNOT COEXIST");
      expect(output).toContain('Declared range "^18.2.0" rejects target version "19.0.0"');
      expect(output).toContain("package.json:dependencies.react");
    });

    it("reports COMPATIBLE when testing react@18.2.0 against fixture-node-basic", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });

      await runWhy(NODE_FIXTURE, "react@18.2.0");
      spy.mockRestore();

      const output = logs.join("\n");
      expect(output).toContain("Target: react@18.2.0");
      expect(output).toContain("Verdict: COMPATIBLE");
    });

    it("explains why fastapi@0.95.0 cannot coexist with fixture-python-basic", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });

      await runWhy(PYTHON_FIXTURE, "fastapi@0.95.0");
      spy.mockRestore();

      const output = logs.join("\n");
      expect(output).toContain("Target: fastapi@0.95.0");
      expect(output).toContain("Verdict: CANNOT COEXIST");
      expect(output).toContain('Declared range ">=0.110,<1" rejects target version "0.95.0"');
    });
  });
});

