import type { DependencyConstraint, PackageVersion } from "../../core/model.js";
import { logger } from "../../util/logger.js";
import { registryCache } from "../../util/cache.js";

const REGISTRY_BASE = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 10_000;

interface NpmVersionMeta {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
}

interface NpmPackageDoc {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions: Record<string, NpmVersionMeta>;
  time?: Record<string, string>;
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
      logger.debug("metadata", `npm registry returned ${res.status} for ${url}`);
      return null;
    }
    const data = await res.json();
    registryCache.set(url, data);
    return data;
  } catch (err) {
    logger.debug("metadata", `npm registry fetch failed for ${url}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toPackageVersion(meta: NpmVersionMeta, publishedAt: string | undefined, distTags: Record<string, string> | undefined): PackageVersion {
  const dependencies: DependencyConstraint[] = [
    ...Object.entries(meta.dependencies ?? {}).map(([name, rawRange]) => ({
      name,
      rawRange,
      kind: "runtime" as const,
      provenance: { source: `npm:${meta.name}@${meta.version}:dependencies.${name}`, rawValue: rawRange },
    })),
    ...Object.entries(meta.peerDependencies ?? {}).map(([name, rawRange]) => ({
      name,
      rawRange,
      kind: "peer" as const,
      provenance: { source: `npm:${meta.name}@${meta.version}:peerDependencies.${name}`, rawValue: rawRange },
    })),
    ...Object.entries(meta.optionalDependencies ?? {}).map(([name, rawRange]) => ({
      name,
      rawRange,
      kind: "optional" as const,
      provenance: { source: `npm:${meta.name}@${meta.version}:optionalDependencies.${name}`, rawValue: rawRange },
    })),
  ];

  const isPrerelease = /-/.test(meta.version); // e.g. 19.0.0-rc.1

  return {
    name: meta.name,
    version: meta.version,
    dependencies,
    runtimeRequirement: meta.engines?.node
      ? {
          name: "node",
          range: meta.engines.node,
          provenance: { source: `npm:${meta.name}@${meta.version}:engines.node`, rawValue: meta.engines.node },
        }
      : undefined,
    platformRequirement:
      meta.os || meta.cpu
        ? { os: meta.os, cpu: meta.cpu, provenance: { source: `npm:${meta.name}@${meta.version}:os/cpu` } }
        : undefined,
    prerelease: isPrerelease,
    deprecated: Boolean(meta.deprecated),
    deprecationMessage: meta.deprecated,
    publishedAt,
    provenance: { source: `npm registry: ${meta.name}@${meta.version}` },
  };
}

/** Fetches all published versions of a package, newest first. */
export async function fetchNpmVersions(packageName: string): Promise<PackageVersion[]> {
  const doc = (await fetchJson(`${REGISTRY_BASE}/${encodeURIComponent(packageName)}`)) as NpmPackageDoc | null;
  if (!doc || !doc.versions) return [];

  const versions = Object.values(doc.versions).map((meta) =>
    toPackageVersion(meta, doc.time?.[meta.version], doc["dist-tags"]),
  );

  // Sort newest first using publish time when available, falling back to registry object order.
  versions.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    return 0;
  });

  return versions;
}

export async function fetchNpmVersion(packageName: string, version: string): Promise<PackageVersion | null> {
  const doc = (await fetchJson(`${REGISTRY_BASE}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`)) as
    | NpmVersionMeta
    | null;
  if (!doc) return null;
  return toPackageVersion(doc, undefined, undefined);
}
