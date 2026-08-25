from __future__ import annotations

import os
from enum import Enum
from typing import List, Optional
from dotenv import find_dotenv, load_dotenv
import instructor
from openai import OpenAI
from pydantic import BaseModel, Field

from dep_risk.extractor import CallSite

# Automatically locate and load the .env file from the repo or parent paths
load_dotenv(find_dotenv(usecwd=True))


class RiskLevel(str, Enum):
    LOW = "LOW"
    MED = "MED"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class AffectedCallSite(BaseModel):
    file_path: str = Field(..., description="Path to the source file where the breaking usage occurs.")
    line_number: int = Field(..., description="Line number of the affected call site.")
    invoked_symbol: str = Field(..., description="Function, method, or class name that is impacted.")
    risk_reason: str = Field(
        ...,
        description="Detailed explanation of why this call site breaks based on the upstream changelog.",
    )


class RiskReport(BaseModel):
    ecosystem: str = Field(..., description="Target ecosystem: python or node.")
    package_name: str = Field(..., description="Name of the analyzed package.")
    current_version: Optional[str] = Field(None, description="Installed or baseline version.")
    target_version: str = Field(..., description="Upstream version being upgraded to.")
    risk_level: RiskLevel = Field(
        ...,
        description="Assessed risk tier (LOW, MED, HIGH, CRITICAL).",
    )
    breaking_changes: List[str] = Field(
        default_factory=list,
        description="Summary of breaking changes from the changelog that directly impact this codebase.",
    )
    affected_call_sites: List[AffectedCallSite] = Field(
        default_factory=list,
        description="Local call sites identified as vulnerable or directly broken by the upgrade.",
    )
    suggested_patch: Optional[str] = Field(
        None,
        description="Unified git diff or concise code migration advice to resolve the broken call sites.",
    )


SYSTEM_PROMPT = """\
You are an expert static analysis and dependency migration engine.
Your task is to analyze breaking change risks when upgrading a library to a new target version.

You will receive:
1. Package metadata and version delta.
2. The raw upstream release notes / changelog.
3. A list of exact code call sites extracted via Tree-sitter AST from the local codebase.

Analysis Instructions:
1. Cross-reference the AST call sites and their surrounding code contexts against the upstream changelog.
2. Flag removed symbols, renamed methods, signature modifications, and dropped configuration flags.
3. Ignore breaking changes in the changelog that do NOT match any detected local call-site usage.
4. Set `risk_level` accurately:
   - LOW: No affected call sites found; changes are purely internal, bugfixes, or additive.
   - MED: Deprecation warnings present or non-fatal signature additions.
   - HIGH: Direct method renames, removed parameters, or signature mismatches in active code.
   - CRITICAL: Core entry point removed, architectural paradigm shift, or major syntax breakage.
5. Provide a valid git diff or concrete patch snippet in `suggested_patch` when breaking changes exist.
"""


class UpgradeRiskEvaluator:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = "llama-3.3-70b-versatile",
    ):
        self.api_key = api_key or os.getenv("GROQ_API_KEY")
        if not self.api_key:
            raise ValueError(
                "GROQ_API_KEY is not set. Please add it to your .env file or environment variables."
            )

        self.base_url = base_url or os.getenv(
            "LLM_BASE_URL", "https://api.groq.com/openai/v1"
        )
        self.model = model

        # Instantiate OpenAI client pointed at Groq
        raw_client = OpenAI(
            base_url=self.base_url,
            api_key=self.api_key,
        )

        # Instructor Mode.JSON ensures reliable structured outputs on Groq
        self.client = instructor.from_openai(raw_client, mode=instructor.Mode.JSON)

    def evaluate(
        self,
        ecosystem: str,
        package_name: str,
        current_version: Optional[str],
        target_version: str,
        changelog: Optional[str],
        call_sites: List[CallSite],
    ) -> RiskReport:
        if not call_sites:
            return RiskReport(
                ecosystem=ecosystem,
                package_name=package_name,
                current_version=current_version,
                target_version=target_version,
                risk_level=RiskLevel.LOW,
                breaking_changes=[],
                affected_call_sites=[],
                suggested_patch="No active usages of this package were detected in the codebase.",
            )

        user_prompt = self._build_prompt(
            ecosystem=ecosystem,
            package_name=package_name,
            current_version=current_version,
            target_version=target_version,
            changelog=changelog or "No release notes available from upstream repository.",
            call_sites=call_sites,
        )

        report: RiskReport = self.client.chat.completions.create(
            model=self.model,
            response_model=RiskReport,
            temperature=0.1,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        )
        return report

    def _build_prompt(
        self,
        ecosystem: str,
        package_name: str,
        current_version: Optional[str],
        target_version: str,
        changelog: str,
        call_sites: List[CallSite],
    ) -> str:
        call_sites_formatted = []
        for idx, site in enumerate(call_sites, start=1):
            call_sites_formatted.append(
                f"### Usage #{idx}\n"
                f"- File: `{site.file_path}:{site.line_number}`\n"
                f"- Symbol: `{site.invoked_symbol}`\n"
                f"- Context:\n```\n{site.code_context}\n```"
            )

        formatted_usages = "\n\n".join(call_sites_formatted)

        return f"""\
# Upgrade Assessment Target
- **Ecosystem**: {ecosystem}
- **Package**: `{package_name}`
- **Version Delta**: `{current_version or 'unknown'}` -> `{target_version}`

# Upstream Release Changelog
---
{changelog}
---

# Local Codebase AST Usages ({len(call_sites)} found)
{formatted_usages}
"""