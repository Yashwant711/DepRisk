from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Optional
import typer
from rich import box
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from dep_risk.evaluator import RiskLevel, RiskReport, UpgradeRiskEvaluator
from dep_risk.extractor import UniversalASTExtractor
from dep_risk.resolvers import detect_ecosystem

app = typer.Typer(
    name="dep-risk",
    help="Fast, multi-language dependency upgrade risk analyzer.",
    add_completion=False,
)
console = Console()


ECOSYSTEM_BADGES = {
    "node": "[bold black on #5FA04E] Node/npm [/bold black on #5FA04E]",
    "python": "[bold white on #3776AB] Python/PyPI [/bold white on #3776AB]",
}

RISK_STYLES = {
    RiskLevel.LOW: ("[bold white on green]  LOW RISK  [/bold white on green]", "green"),
    RiskLevel.MED: ("[bold black on yellow]  MED RISK  [/bold black on yellow]", "yellow"),
    RiskLevel.HIGH: ("[bold white on #E65100]  HIGH RISK  [/bold white on #E65100]", "dark_orange"),
    RiskLevel.CRITICAL: ("[bold white on red blink] CRITICAL RISK [/bold white on red blink]", "red"),
}


def render_report(report: RiskReport) -> None:
    badge, border_color = RISK_STYLES.get(
        report.risk_level, ("[white on red] UNKNOWN [/white on red]", "white")
    )

    # 1. Summary Header Panel
    grid = Table.grid(padding=(0, 2))
    grid.add_column(justify="right", style="bold cyan")
    grid.add_column(justify="left")

    grid.add_row("Package:", f"[bold white]{report.package_name}[/bold white]")
    grid.add_row(
        "Version Delta:",
        f"[yellow]{report.current_version or 'unknown'}[/yellow] → [bold green]{report.target_version}[/bold green]",
    )
    grid.add_row("Assessed Risk:", badge)

    console.print()
    console.print(
        Panel(
            grid,
            title="[bold]Dependency Upgrade Assessment[/bold]",
            border_style=border_color,
            box=box.ROUNDED,
        )
    )

    # 2. Breaking Changes List
    if report.breaking_changes:
        console.print("\n[bold red]Detected Upstream Breaking Changes:[/bold red]")
        for change in report.breaking_changes:
            console.print(f" [bold red]•[/bold red] {change}")

    # 3. Affected Call Sites Table
    if report.affected_call_sites:
        console.print()
        table = Table(
            title="Local Codebase Impact (Tree-sitter Match)",
            box=box.SIMPLE_HEAVY,
            header_style="bold magenta",
        )
        table.add_column("Location", style="cyan", no_wrap=True)
        table.add_column("Invoked Symbol", style="bold yellow")
        table.add_column("Risk / Reason", style="white")

        for site in report.affected_call_sites:
            table.add_row(
                f"{site.file_path}:{site.line_number}",
                site.invoked_symbol,
                site.risk_reason,
            )
        console.print(table)
    else:
        console.print(
            "\n[bold green]✓ No vulnerable or broken call sites detected in local files.[/bold green]"
        )

    # 4. Patch & Migration Guidance
    if report.suggested_patch:
        console.print()
        if "diff" in report.suggested_patch or report.suggested_patch.startswith("---"):
            content = Syntax(
                report.suggested_patch, "diff", theme="monokai", line_numbers=True
            )
        else:
            content = Markdown(report.suggested_patch)

        console.print(
            Panel(
                content,
                title="[bold]Suggested Patch / Migration Path[/bold]",
                border_style="cyan",
                box=box.ROUNDED,
            )
        )
    console.print()


@app.command()
def scan(
    path: Path = typer.Argument(
        Path("."),
        help="Root directory of the project to scan.",
        exists=True,
        file_okay=False,
        dir_okay=True,
        readable=True,
        resolve_path=True,
    ),
    package: str = typer.Option(
        ...,
        "--package",
        "-p",
        help="Target dependency package name to analyze (e.g. pydantic, lodash, axum).",
    ),
    model: str = typer.Option(
        "openai/gpt-oss-20b",
        "--model",
        "-m",
        help="Groq LLM model name used for analysis.",
    ),
    base_url: str = typer.Option("http://localhost:11434/v1", "--base-url", help="OpenAI-compatible base URL."),
):
    """Scan local AST usages and assess breaking upgrade risks against upstream releases."""

    # Step 1: Detect Project Manifest & Ecosystem
    with console.status("[bold green]Detecting project ecosystem...", spinner="dots"):
        try:
            ecosystem, resolver = detect_ecosystem(path)
        except Exception as e:
            console.print(f"[bold red]Detection Error:[/bold red] {e}")
            raise typer.Exit(code=1)

    badge = ECOSYSTEM_BADGES.get(
        ecosystem.value, f"[bold white on blue] {ecosystem.value.upper()} [/bold white on blue]"
    )
    console.print(f"[bold cyan]Project Ecosystem:[/bold cyan] {badge} [dim]({path})[/dim]")

    # Step 2: Fetch Version & Changelog via Registry and GitHub API
    with console.status(
        f"[bold green]Resolving package metadata and changelog for [bold white]'{package}'[/bold white]...",
        spinner="dots",
    ):
        try:
            dep_info = asyncio.run(resolver.get_dependency_info(package, path))
        except Exception as e:
            console.print(f"[bold red]Registry/GitHub Resolution Error:[/bold red] {e}")
            raise typer.Exit(code=1)

    console.print(
        f"[bold cyan]Upstream Release:[/bold cyan] "
        f"[yellow]{dep_info.current_version or 'unspecified'}[/yellow] → "
        f"[bold green]{dep_info.latest_version}[/bold green]"
    )

    # Step 3: Extract Codebase Call Sites using Tree-sitter
    with console.status(
        "[bold green]Extracting call sites with Tree-sitter...", spinner="dots"
    ):
        extractor = UniversalASTExtractor()
        call_sites = extractor.extract_usages(project_dir=path, target_pkg=package)

    console.print(
        f"[bold cyan]Tree-sitter AST:[/bold cyan] Located [bold magenta]{len(call_sites)}[/bold magenta] active usage site(s)."
    )

    # Step 4: Semantic LLM Reasoning
    with console.status(
        f"[bold green]Evaluating breaking changes using {model}...", spinner="dots"
    ):
        evaluator = UpgradeRiskEvaluator(
            base_url=base_url,
            api_key="ollama", # dummy key required by client
            model=model,
        )
        report = evaluator.evaluate(
            ecosystem=ecosystem.value,
            package_name=package,
            current_version=dep_info.current_version,
            target_version=dep_info.latest_version,
            changelog=dep_info.changelog,
            call_sites=call_sites,
        )

    # Step 5: Render Terminal Output
    render_report(report)


if __name__ == "__main__":
    app()