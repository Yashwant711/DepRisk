import { describe, it, expect } from "vitest";
import {
  parsePep440,
  comparePep440Strings,
  satisfiesPep440,
  pep440Intersects,
} from "../../src/core/pep440.js";

describe("PEP 440 Parser and Comparator", () => {
  it("parses standard, pre-release, dev, post, and epoch version strings", () => {
    const v1 = parsePep440("2.31.0");
    expect(v1?.release).toEqual([2, 31, 0]);
    expect(v1?.epoch).toBe(0);

    const v2 = parsePep440("1!1.0.0a2.post1.dev3");
    expect(v2?.epoch).toBe(1);
    expect(v2?.release).toEqual([1, 0, 0]);
    expect(v2?.pre).toEqual({ type: "a", num: 2 });
    expect(v2?.post).toBe(1);
    expect(v2?.dev).toBe(3);
  });

  it("correctly compares versions according to PEP 440 ordering", () => {
    expect(comparePep440Strings("2.31.0", "2.31.1")).toBe(-1);
    expect(comparePep440Strings("3.10.0", "3.9.9")).toBe(1);
    expect(comparePep440Strings("1.0.0a1", "1.0.0b1")).toBe(-1);
    expect(comparePep440Strings("1.0.0rc1", "1.0.0")).toBe(-1);
    expect(comparePep440Strings("1.0.0", "1.0.0.post1")).toBe(-1);
    expect(comparePep440Strings("1.0.0.dev1", "1.0.0a1")).toBe(-1);
    expect(comparePep440Strings("1.0.0", "1.0.0")).toBe(0);
  });

  it("evaluates single and compound specifiers", () => {
    expect(satisfiesPep440("2.31.0", "==2.31.0")).toBe(true);
    expect(satisfiesPep440("2.31.1", "==2.31.0")).toBe(false);
    expect(satisfiesPep440("2.31.5", "==2.31.*")).toBe(true);
    expect(satisfiesPep440("2.32.0", "==2.31.*")).toBe(false);

    expect(satisfiesPep440("0.110.0", ">=0.110,<1")).toBe(true);
    expect(satisfiesPep440("0.95.0", ">=0.110,<1")).toBe(false);
    expect(satisfiesPep440("1.0.0", ">=0.110,<1")).toBe(false);

    expect(satisfiesPep440("3.10.4", ">=3.10,!=3.10.4")).toBe(false);
    expect(satisfiesPep440("3.10.5", ">=3.10,!=3.10.4")).toBe(true);

    // Compatible release ~=
    expect(satisfiesPep440("2.2.1", "~=2.2.0")).toBe(true);
    expect(satisfiesPep440("2.3.0", "~=2.2.0")).toBe(false);
    expect(satisfiesPep440("2.1.9", "~=2.2.0")).toBe(false);
  });

  it("checks range intersections", () => {
    expect(pep440Intersects(">=3.10", ">=3.12")).toBe(true);
    expect(pep440Intersects(">=3.10,<3.11", ">=3.12")).toBe(false);
    expect(pep440Intersects("==2.31.0", ">=2.0.0,<3.0.0")).toBe(true);
    expect(pep440Intersects("==2.31.0", "==2.30.0")).toBe(false);
  });
});

