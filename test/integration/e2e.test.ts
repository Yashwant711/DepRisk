import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInspect } from "../../src/cli/inspect.js";
import { runWhy } from "../../src/cli/why.js";
import { runVersions } from "../../src/cli/versions.js";
import { runCheck } from "../../src/cli/check.js";
import { runChanges } from "../../src/cli/changes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_BASIC = path.join(__dirname, "..", "fixtures", "node-basic");
const NODE_RUNTIME_CONFLICT = path.join(__dirname, "..", "fixtures", "node-runtime-conflict");
const NODE_PEER_CONFLICT = path.join(__dirname, "..", "fixtures", "node-peer-conflict");
const PYTHON_BASIC = path.join(__dirname, "..", "fixtures", "python-basic");
const PYTHON_RUNTIME_CONFLICT = path.join(__dirname, "..", "fixtures", "python-runtime-conflict");

describe("End-to-End CLI Verification", () => {
  describe("inspect command", () => {
    it("inspects Node.js repository", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runInspect(NODE_BASIC);
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("ecosystem: Node.js");
      expect(out).toContain("package manager: npm");
      expect(out).toContain("runtime: >=18");
      expect(out).toContain("lockfile: package-lock.json");
    });

    it("inspects Python repository", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runInspect(PYTHON_BASIC);
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("ecosystem: Python");
      expect(out).toContain("runtime: >=3.10");
    });
  });

  describe("why command", () => {
    it("identifies runtime incompatibility on node-runtime-conflict", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runWhy(NODE_RUNTIME_CONFLICT, "express@5.0.0");
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Target: express@5.0.0");
    });

    it("identifies inverted peer conflict on node-peer-conflict", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runWhy(NODE_PEER_CONFLICT, "react@19.0.0");
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Verdict: CANNOT COEXIST");
      expect(out).toContain("react-dom");
    });

    it("reports compatible when package matches current graph", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runWhy(NODE_BASIC, "react@18.2.0");
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Verdict: COMPATIBLE");
    });
  });

  describe("versions command", () => {
    it("discovers compatible versions with --major filter", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runVersions(NODE_BASIC, "react", { major: "18" });
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Compatible Versions");
      expect(out).toContain("18.3.1");
    });

    it("discovers compatible versions with --range filter", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runVersions(PYTHON_BASIC, "requests", { range: ">=2.31.0" });
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Compatible Versions");
      expect(out).toContain("2.31.0");
    });
  });

  describe("check command", () => {
    it("performs single version check", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runCheck(NODE_BASIC, "react@18.2.0", { skipInstall: true });
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("Verdict: PASS (Likely Safe)");
      expect(out).toContain("Verification Pipeline:");
    });

    it("performs upgrade safety analysis", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runCheck(NODE_BASIC, "react", { skipInstall: true });
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("DepRisk — Upgrade Safety Analysis");
      expect(out).toContain("Recommendation:");
    });
  });

  describe("changes command", () => {
    it("generates full actionable migration plan with affected files", async () => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        logs.push(msg);
      });
      await runChanges(NODE_BASIC, "react@19.0.0");
      spy.mockRestore();

      const out = logs.join("\n");
      expect(out).toContain("DepRisk — Migration & Change Plan");
      expect(out).toContain("npm install react@^19.0.0");
      expect(out).toContain("src\\index.ts");
    });
  });
});

