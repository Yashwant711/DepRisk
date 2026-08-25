from __future__ import annotations

import re
from pathlib import Path
from typing import Optional
import httpx
import tomllib

from .base import BaseResolver, DependencyInfo
from .github import GitHubChangelogFetcher


class PythonResolver(BaseResolver):
    def __init__(self, gh_fetcher: Optional[GitHubChangelogFetcher] = None):
        self.gh_fetcher = gh_fetcher or GitHubChangelogFetcher()

    async def get_dependency_info(
        self, package_name: str, project_dir: Path
    ) -> DependencyInfo:
        current_version = self._read_current_version(project_dir, package_name)

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"https://pypi.org/pypi/{package_name}/json")
            resp.raise_for_status()
            data = resp.json()

            info = data.get("info", {})
            latest_version = info.get("version", "unknown")
            project_urls = info.get("project_urls") or {}

            urls_to_check = [
                project_urls.get("Source"),
                project_urls.get("Source Code"),
                project_urls.get("Repository"),
                project_urls.get("Homepage"),
                info.get("home_page"),
                info.get("project_url"),
            ]

            owner, repo = self.extract_github_coords(*urls_to_check)
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
        # 1. pyproject.toml
        pyproject_file = project_dir / "pyproject.toml"
        if pyproject_file.exists():
            try:
                with open(pyproject_file, "rb") as f:
                    data = tomllib.load(f)
                deps = data.get("project", {}).get("dependencies", [])
                for dep in deps:
                    match = re.match(
                        rf"^{re.escape(package_name)}(?:\[.*?\])?(?:[><=~^! ]+([0-9A-Za-z_.\-]+))?",
                        dep,
                        re.IGNORECASE,
                    )
                    if match:
                        return match.group(1)
            except Exception:
                pass

        # 2. requirements.txt
        req_file = project_dir / "requirements.txt"
        if req_file.exists():
            try:
                with open(req_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("#") or not line:
                            continue
                        match = re.match(
                            rf"^{re.escape(package_name)}(?:\[.*?\])?(?:[><=~^! ]+([0-9A-Za-z_.\-]+))?",
                            line,
                            re.IGNORECASE,
                        )
                        if match:
                            return match.group(1)
            except Exception:
                pass

        return None