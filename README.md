# DepRisk

DepRisk is a CLI tool for estimating upgrade risk before bumping a dependency in a project. It scans the local codebase, identifies how a dependency is used, fetches upstream release metadata, and asks an LLM to judge whether a version upgrade is likely to break code.

## What it is trying to do

The project is designed to:

- Detect the package ecosystem automatically: Python or Node.js.
- Read the currently installed version from the project manifest.
- Query the package registry for the latest published version.
- Try to fetch release notes or changelog information from the upstream GitHub repository.
- Extract actual call sites from the codebase with Tree-sitter.
- Compare local usage patterns against upstream breaking changes.
- Produce a risk summary with findings, affected symbols, and migration guidance.

The main flow lives in:

- [dep_risk/main.py](dep_risk/main.py) — CLI entry point and orchestration.
- [dep_risk/extractor.py](dep_risk/extractor.py) — Tree-sitter import and call-site extraction.
- [dep_risk/evaluator.py](dep_risk/evaluator.py) — LLM-backed risk evaluation and structured output.
- [dep_risk/resolvers](dep_risk/resolvers) — registry and ecosystem-specific metadata fetchers.

## Intended workflow

The CLI is meant to be used like this:

```bash
# from the project root
pip install -r requirements.txt
# optionally set a key for Ollama-compatible or Groq-compatible APIs
# export GROQ_API_KEY=...

dep-risk . -p rich
```

The tool also supports an explicit model/base URL:

```bash
dep-risk . -p rich --base-url http://localhost:11434/v1 --model llama-3.3-70b-versatile
```

This project is designed to work with an OpenAI-compatible local or remote API endpoint. The default CLI assumes a local Ollama endpoint at `http://localhost:11434/v1`.

## Current failure in this workspace

The project currently fails before it can finish a real scan because of a dependency mismatch in the Tree-sitter setup.

### Root cause

In [dep_risk/extractor.py](dep_risk/extractor.py), the code calls:

```python
lang.query(imp_q_str)
lang.query(call_q_str)
```

But the installed `tree_sitter` package in this environment is version `0.26.0`, and the actual runtime error is:

```python
AttributeError: 'tree_sitter.Language' object has no attribute 'query'
```

This means the project was written against an older or different Tree-sitter API surface than the one installed here. The code expects `Language.query(...)` to exist, but the installed package exposes a newer/different binding model.

### Verified evidence

I verified this by running:

```bash
python -m dep_risk.main . -p rich
```

and the stack trace stops in [dep_risk/extractor.py](dep_risk/extractor.py) at the language initialization block with the exact `AttributeError` above.

## Other important note

The evaluator in [dep_risk/evaluator.py](dep_risk/evaluator.py) expects a valid API key for the LLM client and is written around the OpenAI client pattern. If you are using a local Ollama endpoint, the code usually works with a dummy API key such as `ollama`, but it still needs a valid base URL and an LLM endpoint that accepts OpenAI-compatible requests.

## Suggested next steps

1. Align the Tree-sitter package versions with the API this project expects.
2. Confirm the installed dependency versions in the environment.
3. Re-run the CLI once the parser layer initializes correctly.
4. If using local Ollama, ensure the server is running and the base URL is reachable.

## Project status

The project is conceptually sound, but the current environment is blocked by a runtime incompatibility in the Tree-sitter integration.
