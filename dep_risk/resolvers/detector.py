from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Tuple

from .base import BaseResolver
from .node import NodeResolver
from .python import PythonResolver


class Ecosystem(str, Enum):
    NODE = "node"
    PYTHON = "python"
    UNKNOWN = "unknown"


def detect_ecosystem(project_dir: Path) -> Tuple[Ecosystem, BaseResolver]:
    """Inspects manifest files and returns the matching ecosystem and resolver."""
    project_dir = project_dir.resolve()

    if (project_dir / "package.json").exists():
        return Ecosystem.NODE, NodeResolver()

    if (project_dir / "pyproject.toml").exists() or (project_dir / "requirements.txt").exists():
        return Ecosystem.PYTHON, PythonResolver()

    raise FileNotFoundError(
        f"Could not auto-detect ecosystem in '{project_dir}'. "
        "Missing package.json, pyproject.toml, or requirements.txt."
    )