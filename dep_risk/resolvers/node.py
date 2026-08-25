from __future__ import annotations

import json
from pathlib import Path
from typing import Optional
import httpx

from .base import BaseResolver, DependencyInfo
from .github import GitHubChangelogFetcher


class NodeResolver(BaseResolver):
    def __init__(self, gh_fetcher: Optional[GitHubChangelogFetcher] = None):
        self.gh_fetcher = gh_fetcher or GitHubChangelogFetcher()

    async def get_dependency_info(
        self, package_name: str, project_dir: Path
    ) -> DependencyInfo:
        current_version = self._read_current_version(project_dir, package_name)

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"https://registry.npmjs.org/{package_name}")
            resp.raise_for_status()
            data = resp.json()

            latest_version = data.get("dist-tags", {}).get("latest", "unknown")
            repo_data = data.get("repository", {})
            repo_url = repo_data.get("url") if isinstance(repo_data, dict) else repo_data
            homepage = data.get("homepage")

            owner, repo = self.extract_github_coords(repo_url, homepage)
            changelog = None
            if owner and repo:
                changelog = await self.gh_fetcher.fetch_changelog(
                    owner, repo, target_tag=latest_version, client=client
                )

            return DependencyInfo(
                name=package_name,
                current_version=current_version,
                latest_version=latest_version,
                repo_owner=owner,
                repo_name=repo,
                changelog=changelog,
            )

    def _read_current_version(self, project_dir: Path, package_name: str) -> Optional[str]:
        pkg_json = project_dir / "package.json"
        if not pkg_json.exists():
            return None
        try:
            with open(pkg_json, "r", encoding="utf-8") as f:
                data = json.load(f)
            deps = {
                **data.get("dependencies", {}),
                **data.get("devDependencies", {}),
            }
            raw_v = deps.get(package_name)
            return raw_v.lstrip("^~>=<") if raw_v else None
        except Exception:
            return None