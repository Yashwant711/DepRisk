import type { PackageAdapter } from "./adapter.js";
import { NodeAdapter } from "../adapters/node/index.js";
import { PythonAdapter } from "../adapters/python/index.js";
import { logger } from "../util/logger.js";

const ADAPTERS: PackageAdapter[] = [new NodeAdapter(), new PythonAdapter()];

export interface EcosystemDetectionSummary {
  adapter: PackageAdapter;
  confidence: number;
  reason: string;
}

/**
 * Runs detection across every known adapter. Returns matches sorted by
 * confidence, highest first. Callers should generally use the first result,
 * but the full list is preserved for monorepos / multi-ecosystem repos
 * (e.g. a Python backend with a Node.js frontend) which the MVP does not
 * yet fully support but should not crash on.
 */
export async function detectEcosystems(root: string): Promise<EcosystemDetectionSummary[]> {
  const results: EcosystemDetectionSummary[] = [];
  for (const adapter of ADAPTERS) {
    const detection = await adapter.detect(root);
    logger.debug(
      "repository",
      `${adapter.ecosystem} detection: matches=${detection.matches} confidence=${detection.confidence} (${detection.reason})`,
    );
    if (detection.matches) {
      results.push({ adapter, confidence: detection.confidence, reason: detection.reason });
    }
  }
  return results.sort((a, b) => b.confidence - a.confidence);
}

export function listAdapters(): PackageAdapter[] {
  return ADAPTERS;
}
