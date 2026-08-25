from __future__ import annotations

import os
from typing import Optional
import httpx


class GitHubChangelogFetcher:
    def __init__(self, token: Optional[str] = None):
        self.token = token or os.getenv("GITHUB_TOKEN")
        self.headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "dep-risk-cli",
        }
        if self.token:
            self.headers["Authorization"] = f"Bearer {self.token}"

    async def fetch_changelog(
        self,
        owner: str,
        repo: str,
        target_tag: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> Optional[str]:
        """Fetch release body by tag with fallback to latest release."""
        should_close = False
        if client is None:
            client = httpx.AsyncClient(headers=self.headers, timeout=10.0)
            should_close = True

        try:
            if target_tag:
                tags_to_try = [target_tag, f"v{target_tag}"]
                for tag in tags_to_try:
                    res = await client.get(
                        f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}",
                        headers=self.headers,
                    )
                    if res.status_code == 200:
                        return res.json().get("body", "")

            latest_res = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/releases/latest",
                headers=self.headers,
            )
            if latest_res.status_code == 200:
                return latest_res.json().get("body", "")

            return None
        finally:
            if should_close:
                await client.aclose()