import { describe, it, expect } from "vitest";
import {
  satisfiesVersion,
  rangesIntersect,
  checkRuntimeCompatibility,
} from "../../src/core/version-matcher.js";

describe("version-matcher", () => {
  describe("satisfiesVersion", () => {
    it("works for Node semver", () => {
      expect(satisfiesVersion("18.2.0", "^18.0.0", "node")).toBe(true);
      expect(satisfiesVersion("19.0.0", "^18.0.0", "node")).toBe(false);
      expect(satisfiesVersion("18.2.0", ">=16 <20", "node")).toBe(true);
    });

    it("works for Python PEP 440", () => {
      expect(satisfiesVersion("2.31.0", "==2.31.0", "python")).toBe(true);
      expect(satisfiesVersion("2.31.1", "==2.31.0", "python")).toBe(false);
      expect(satisfiesVersion("0.110.0", ">=0.110,<1", "python")).toBe(true);
    });
  });

  describe("rangesIntersect", () => {
    it("detects overlapping Node ranges", () => {
      expect(rangesIntersect("^18.0.0", ">=18.2.0 <20.0.0", "node")).toBe(true);
      expect(rangesIntersect("^18.0.0", "^19.0.0", "node")).toBe(false);
    });

    it("detects overlapping Python ranges", () => {
      expect(rangesIntersect(">=3.10", ">=3.11", "python")).toBe(true);
      expect(rangesIntersect(">=3.8,<3.10", ">=3.11", "python")).toBe(false);
    });
  });

  describe("checkRuntimeCompatibility", () => {
    it("handles compatible declared ranges", () => {
      const res = checkRuntimeCompatibility(
        { name: "node", range: ">=18", provenance: { source: "package.json:engines.node" } },
        { name: "node", range: ">=18.0.0", provenance: { source: "npm:pkg:engines.node" } },
        "node",
      );
      expect(res.compatible).toBe(true);
    });

    it("detects disjoint declared runtime ranges", () => {
      const res = checkRuntimeCompatibility(
        { name: "node", range: ">=16 <18", provenance: { source: "package.json:engines.node" } },
        { name: "node", range: ">=20.0.0", provenance: { source: "npm:pkg:engines.node" } },
        "node",
      );
      expect(res.compatible).toBe(false);
      expect(res.reason).toContain("disjoint");
    });

    it("detects incompatible host detected runtime version", () => {
      const res = checkRuntimeCompatibility(
        { name: "python", detectedVersion: "3.9.5", provenance: { source: "host" } },
        { name: "python", range: ">=3.10", provenance: { source: "pypi:pkg:requires_python" } },
        "python",
      );
      expect(res.compatible).toBe(false);
      expect(res.reason).toContain("does not satisfy package requirement");
    });
  });
});

