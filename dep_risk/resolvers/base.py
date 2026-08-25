from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class DependencyInfo:
    name: str
    current_version: Optional[str]
    latest_version: str
    repo_owner: Optional[str]
    repo_name: Optional[str]
    changelog: Optional[str] = None


class BaseResolver(ABC):
    @abstractmethod
    async def get_dependency_info(
        self, package_name: str, project_dir: Path
    ) -> DependencyInfo:
        """Parse local manifest for current version and query registry for metadata."""
        pass

    @staticmethod
    def extract_github_coords(
        *candidates: Optional[str],
    ) -> tuple[Optional[str], Optional[str]]:
        """Extract (owner, repo) from GitHub URLs."""
        pattern = re.compile(
            r"(?:git\+)?https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git|/.*)?$"
        )
        for url in candidates:
            if not url:
                continue
            match = pattern.search(url.strip())
            if match:
                return match.group(1), match.group(2)
        return None, None