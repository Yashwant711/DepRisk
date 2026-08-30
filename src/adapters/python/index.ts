import type { PackageAdapter, DetectionResult } from "../../core/adapter.js";
import type { PackageVersion, RepositoryModel } from "../../core/model.js";
import { detectPython, buildPythonRepositoryModel } from "./repository.js";
import { fetchPypiVersion, fetchPypiVersions } from "./registry.js";
import { readTextFile } from "../../util/fs.js";

export class PythonAdapter implements PackageAdapter {
  readonly ecosystem = "python" as const;

  async detect(root: string): Promise<DetectionResult> {
    return detectPython(root);
  }

  async buildRepositoryModel(root: string): Promise<RepositoryModel> {
    return buildPythonRepositoryModel(root);
  }

  async fetchPackageVersions(packageName: string): Promise<PackageVersion[]> {
    return fetchPypiVersions(packageName);
  }

  async fetchPackageVersion(packageName: string, version: string): Promise<PackageVersion | null> {
    return fetchPypiVersion(packageName, version);
  }

  async getCurrentVersion(model: RepositoryModel, packageName: string): Promise<string | null> {
    // MVP: poetry.lock/uv.lock parsing (TOML) can be added once the dependency-resolution
    // milestone needs exact pinned versions. For now, fall back to the declared range.
    if (model.lockState.lockfile === "poetry.lock" || model.lockState.lockfile === "uv.lock") {
      const lockText = await readTextFile(model.root, model.lockState.lockfile);
      if (lockText) {
        // Cheap heuristic scan: look for `name = "<pkg>"` followed by `version = "<x>"` in the same block.
        const blockRegex = new RegExp(
          `name\\s*=\\s*"${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"[\\s\\S]{0,200}?version\\s*=\\s*"([^"]+)"`,
          "i",
        );
        const match = lockText.match(blockRegex);
        if (match) return match[1];
      }
    }
    const declared = [...model.dependencies, ...model.devDependencies].find(
      (d) => d.name.toLowerCase() === packageName.toLowerCase(),
    );
    if (!declared) return null;
    const cleaned = declared.rawRange.replace(/^[=><~!^]+/, "").split(",")[0].trim();
    return cleaned || null;
  }
}

export function isPythonAdapter(a: PackageAdapter): a is PythonAdapter {
  return a.ecosystem === "python";
}
