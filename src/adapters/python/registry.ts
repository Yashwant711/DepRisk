import type { DependencyConstraint, PackageVersion } from "../../core/model.js";
import { logger } from "../../util/logger.js";
import { registryCache } from "../../util/cache.js";

const PYPI_BASE = "https://pypi.org/pypi";
const FETCH_TIMEOUT_MS = 10_000;

interface PypiRelease {
  requires_dist?: string[] | null;
  requires_python?: string | null;
  yanked?: boolean;
  yanked_reason?: string;
}

interface PypiInfo {
  name: string;
  version: string;
  requires_dist?: string[] | null;
  requires_python?: string | null;
  yanked?: boolean;
  yanked_reason?: string;
}

interface PypiUploadFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
  yanked_reason?: string;
}

interface PypiPackageDoc {
  info: PypiInfo;
  releases: Record<string, PypiUploadFile[]>;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const cached = registryCache.get<unknown>(url);
  if (cached !== undefined) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.debug("metadata", `PyPI returned ${res.status} for ${url}`);
      return null;
    }
    const data = await res.json();
    registryCache.set(url, data);
    return data;
  } catch (err) {
    logger.debug("metadata", `PyPI fetch failed for ${url}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Parses a PEP 508 requirement string like "requests (>=2.0) ; extra == 'foo'" into a DependencyConstraint. */
function parseRequiresDist(reqString: string, source: string): DependencyConstraint | null {
  const [reqPart, markerPart] = reqString.split(";").map((s) => s.trim());
  const match = reqPart.match(/^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*\(?([^)]*)\)?$/);
  if (!match) return null;
  const [, name, , specifier] = match;
  const isExtra = markerPart?.includes("extra ==");
  return {
    name,
    rawRange: specifier.trim() || "*",
    kind: isExtra ? "optional" : "runtime",
    environmentMarker: markerPart || undefined,
    provenance: { source: `${source}:${name}`, rawValue: reqString },
  };
}

function toPackageVersion(
  name: string,
  version: string,
  release: { requires_dist?: string[] | null; requires_python?: string | null },
  publishedAt: string | undefined,
  yanked: boolean,
  yankedReason: string | undefined,
): PackageVersion {
  const dependencies = (release.requires_dist ?? [])
    .map((r) => parseRequiresDist(r, `pypi:${name}@${version}:requires_dist`))
    .filter((d): d is DependencyConstraint => d !== null);

  return {
    name,
    version,
    dependencies,
    runtimeRequirement: release.requires_python
      ? {
          name: "python",
          range: release.requires_python,
          provenance: { source: `pypi:${name}@${version}:requires_python`, rawValue: release.requires_python },
        }
      : undefined,
    prerelease: /(a|b|rc|dev)\d*$/i.test(version),
    deprecated: yanked,
    deprecationMessage: yankedReason,
    publishedAt,
    provenance: { source: `PyPI: ${name}@${version}` },
  };
}

export async function fetchPypiVersions(packageName: string): Promise<PackageVersion[]> {
  const doc = (await fetchJson(`${PYPI_BASE}/${encodeURIComponent(packageName)}/json`)) as PypiPackageDoc | null;
  if (!doc || !doc.releases) return [];

  const versions: PackageVersion[] = [];
  for (const [version, files] of Object.entries(doc.releases)) {
    if (!files || files.length === 0) continue; // no uploaded files for this version record
    const publishedAt = files[0]?.upload_time_iso_8601;
    const yanked = files.some((f) => f.yanked);
    const yankedReason = files.find((f) => f.yanked)?.yanked_reason;
    // PyPI's per-release requires_dist isn't in the releases map; approximate with top-level info
    // for the current version, and fall back to empty deps for historical ones (see fetchPypiVersion
    // for the accurate per-version fetch).
    const isCurrent = version === doc.info.version;
    versions.push(
      toPackageVersion(
        packageName,
        version,
        isCurrent ? doc.info : {},
        publishedAt,
        yanked,
        yankedReason,
      ),
    );
  }

  versions.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    return 0;
  });

  return versions;
}

/** Fetches accurate per-version metadata (requires_dist, requires_python) for one specific release. */
export async function fetchPypiVersion(packageName: string, version: string): Promise<PackageVersion | null> {
  const doc = (await fetchJson(`${PYPI_BASE}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`)) as
    | PypiPackageDoc
    | null;
  if (!doc) return null;
  const files = doc.releases?.[version] ?? [];
  const yanked = files.some((f) => f.yanked) || Boolean(doc.info.yanked);
  return toPackageVersion(packageName, version, doc.info, files[0]?.upload_time_iso_8601, yanked, doc.info.yanked_reason);
}
