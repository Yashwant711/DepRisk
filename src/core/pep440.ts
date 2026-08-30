/**
 * PEP 440 version parsing and specifier matching for Python packages.
 */

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre?: { type: "a" | "b" | "rc"; num: number };
  post?: number;
  dev?: number;
  raw: string;
}

export function parsePep440(raw: string): Pep440Version | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Epoch: e.g. 1!2.0.0
  const epochMatch = trimmed.match(/^(\d+)!/);
  const epoch = epochMatch ? parseInt(epochMatch[1], 10) : 0;
  const noEpoch = epochMatch ? trimmed.slice(epochMatch[0].length) : trimmed;

  // Release segment
  const match = noEpoch.match(
    /^(\d+(?:\.\d+)*)(?:[-._]?(a|b|rc|alpha|beta|c|pre|preview)(\d*))?(?:[-._]?(post|rev|r)(\d*))?(?:[-._]?(dev)(\d*))?$/i,
  );

  if (!match) {
    // Try simple number extraction if possible
    const simple = trimmed.match(/^(\d+(?:\.\d+)*)/);
    if (!simple) return null;
    return {
      epoch,
      release: simple[1].split(".").map((n) => parseInt(n, 10)),
      raw: trimmed,
    };
  }

  const [, relStr, preTypeStr, preNumStr, postTypeStr, postNumStr, devTypeStr, devNumStr] = match;
  const release = relStr.split(".").map((n) => parseInt(n, 10));

  let pre: Pep440Version["pre"] | undefined;
  if (preTypeStr) {
    let type: "a" | "b" | "rc" = "rc";
    const lower = preTypeStr.toLowerCase();
    if (lower.startsWith("a")) type = "a";
    else if (lower.startsWith("b")) type = "b";
    else if (lower.startsWith("c") || lower.startsWith("rc") || lower.startsWith("pre") || lower.startsWith("preview")) {
      type = "rc";
    }
    const num = preNumStr ? parseInt(preNumStr, 10) : 0;
    pre = { type, num };
  }

  let post: number | undefined;
  if (postTypeStr) {
    post = postNumStr ? parseInt(postNumStr, 10) : 0;
  }

  let dev: number | undefined;
  if (devTypeStr) {
    dev = devNumStr ? parseInt(devNumStr, 10) : 0;
  }

  return {
    epoch,
    release,
    pre,
    post,
    dev,
    raw: trimmed,
  };
}

/**
 * Compares two PEP 440 versions.
 * Returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2.
 */
export function comparePep440(v1: Pep440Version, v2: Pep440Version): number {
  if (v1.epoch !== v2.epoch) {
    return v1.epoch < v2.epoch ? -1 : 1;
  }

  const maxLen = Math.max(v1.release.length, v2.release.length);
  for (let i = 0; i < maxLen; i++) {
    const r1 = v1.release[i] ?? 0;
    const r2 = v2.release[i] ?? 0;
    if (r1 !== r2) {
      return r1 < r2 ? -1 : 1;
    }
  }

  // Pre-release comparison
  // Dev release < Pre release < Final release < Post release
  const getPreOrder = (v: Pep440Version): number => {
    if (v.dev !== undefined && v.pre === undefined) return 0; // e.g. 1.0.dev1
    if (v.pre) {
      if (v.pre.type === "a") return 1;
      if (v.pre.type === "b") return 2;
      if (v.pre.type === "rc") return 3;
    }
    return 4; // Final release
  };

  const p1 = getPreOrder(v1);
  const p2 = getPreOrder(v2);
  if (p1 !== p2) {
    return p1 < p2 ? -1 : 1;
  }

  if (v1.pre && v2.pre) {
    if (v1.pre.num !== v2.pre.num) {
      return v1.pre.num < v2.pre.num ? -1 : 1;
    }
  }

  // Post release comparison
  const post1 = v1.post ?? -1;
  const post2 = v2.post ?? -1;
  if (post1 !== post2) {
    return post1 < post2 ? -1 : 1;
  }

  // Dev release comparison
  const dev1 = v1.dev ?? Infinity;
  const dev2 = v2.dev ?? Infinity;
  if (dev1 !== dev2) {
    return dev1 < dev2 ? -1 : 1;
  }

  return 0;
}

export function comparePep440Strings(s1: string, s2: string): number {
  const v1 = parsePep440(s1);
  const v2 = parsePep440(s2);
  if (!v1 || !v2) return s1.localeCompare(s2);
  return comparePep440(v1, v2);
}

interface SpecifierClause {
  op: "==" | "!=" | "<=" | "<" | ">=" | ">" | "~=" | "===";
  versionStr: string;
  isPrefix: boolean;
}

function parseClause(raw: string): SpecifierClause | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") return null;

  const match = trimmed.match(/^(===|==|!=|<=|>=|<|>|~=)\s*(.+)$/);
  if (!match) {
    const isPref = trimmed.endsWith(".*");
    const cleanVer = trimmed.replace(/\.\*$/, "");
    return { op: "==", versionStr: cleanVer, isPrefix: isPref };
  }

  const op = match[1] as SpecifierClause["op"];
  let versionStr = match[2].trim();
  const isPrefix = versionStr.endsWith(".*");
  if (isPrefix) {
    versionStr = versionStr.replace(/\.\*$/, "");
  }

  return { op, versionStr, isPrefix };
}

function matchesPrefix(v: Pep440Version, prefixRelease: number[]): boolean {
  for (let i = 0; i < prefixRelease.length; i++) {
    if ((v.release[i] ?? 0) !== prefixRelease[i]) return false;
  }
  return true;
}

function testClause(v: Pep440Version, clause: SpecifierClause): boolean {
  if (clause.op === "===") {
    return v.raw === clause.versionStr;
  }

  const targetVer = parsePep440(clause.versionStr);
  if (!targetVer) return false;

  if (clause.isPrefix) {
    const prefixMatch = matchesPrefix(v, targetVer.release);
    if (clause.op === "==") return prefixMatch;
    if (clause.op === "!=") return !prefixMatch;
  }

  const cmp = comparePep440(v, targetVer);

  switch (clause.op) {
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "~=": {
      // Compatible release clause: ~= X.Y.Z means >= X.Y.Z, == X.Y.*
      if (cmp < 0) return false;
      const prefixLen = Math.max(1, targetVer.release.length - 1);
      const prefix = targetVer.release.slice(0, prefixLen);
      return matchesPrefix(v, prefix);
    }
    default:
      return false;
  }
}

/**
 * Tests whether a Python version satisfies a PEP 440 specifier string.
 * Supports comma-separated clauses (e.g. ">=0.110,<1", ">=3.10,!=3.11.0").
 */
export function satisfiesPep440(version: string, specifier: string): boolean {
  const trimmed = specifier.trim();
  if (!trimmed || trimmed === "*") return true;

  const v = parsePep440(version);
  if (!v) return false;

  const clauses = trimmed
    .split(",")
    .map((c) => parseClause(c))
    .filter((c): c is SpecifierClause => c !== null);

  if (clauses.length === 0) return true;

  return clauses.every((clause) => testClause(v, clause));
}

/**
 * Checks if two PEP 440 specifiers intersect / have compatible overlapping versions.
 */
export function pep440Intersects(spec1: string, spec2: string): boolean {
  const s1 = spec1.trim();
  const s2 = spec2.trim();
  if (!s1 || s1 === "*" || !s2 || s2 === "*") return true;

  // Candidate samples to test against both specifiers:
  const extractCandidates = (spec: string): string[] => {
    const matches = spec.match(/\d+(?:\.\d+)*/g) ?? [];
    const candidates: string[] = [];
    for (const m of matches) {
      candidates.push(m);
      const parts = m.split(".").map(Number);
      if (parts.length >= 2) {
        candidates.push(`${parts[0]}.${parts[1] + 1}`);
        candidates.push(`${parts[0]}.${parts[1]}.1`);
        candidates.push(`${parts[0]}.${parts[1]}.99`);
      }
      if (parts.length === 1) {
        candidates.push(`${parts[0]}.0`);
        candidates.push(`${parts[0]}.1`);
        candidates.push(`${parts[0]}.9`);
      }
    }
    return candidates;
  };

  const candidates = Array.from(new Set([...extractCandidates(s1), ...extractCandidates(s2)]));
  for (const cand of candidates) {
    if (satisfiesPep440(cand, s1) && satisfiesPep440(cand, s2)) {
      return true;
    }
  }

  return checkBoundsOverlap(s1, s2);
}

function checkBoundsOverlap(s1: string, s2: string): boolean {
  const parseBounds = (spec: string): { min?: Pep440Version; max?: Pep440Version } => {
    const clauses = spec
      .split(",")
      .map(parseClause)
      .filter((c): c is SpecifierClause => c !== null);
    let min: Pep440Version | undefined;
    let max: Pep440Version | undefined;
    for (const c of clauses) {
      const v = parsePep440(c.versionStr);
      if (!v) continue;
      if (c.op === ">=" || c.op === ">") {
        if (!min || comparePep440(v, min) > 0) min = v;
      }
      if (c.op === "<=" || c.op === "<") {
        if (!max || comparePep440(v, max) < 0) max = v;
      }
      if (c.op === "==" && !c.isPrefix) {
        min = v;
        max = v;
      }
    }
    return { min, max };
  };

  const b1 = parseBounds(s1);
  const b2 = parseBounds(s2);

  if (b1.min && b2.max && comparePep440(b1.min, b2.max) > 0) return false;
  if (b2.min && b1.max && comparePep440(b2.min, b1.max) > 0) return false;

  return true;
}

