from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Set, Tuple
import tree_sitter_javascript as ts_js
import tree_sitter_python as ts_py
import tree_sitter_rust as ts_rust
import tree_sitter_typescript as ts_ts
from tree_sitter import Language, Node, Parser, Query


@dataclass
class CallSite:
    file_path: str
    line_number: int
    invoked_symbol: str
    code_context: str


# ----------------------------------------------------------------------
# Tree-sitter S-Expression Queries
# ----------------------------------------------------------------------

# Python Queries
PY_IMPORT_QUERY = """
(import_name
  (dotted_name) @import_pkg)

(import_from_statement
  module_name: (dotted_name) @import_pkg
  name: (dotted_name)? @import_sub
  (import_as_names
    (import_as_name
      name: (dotted_name) @aliased_orig
      alias: (identifier) @aliased_name))?)
"""

PY_CALL_QUERY = """
(call
  function: [
    (identifier) @func_ident
    (attribute
      object: [
        (identifier) @attr_obj
        (attribute) @nested_attr_obj
      ]
      attribute: (identifier) @attr_func)
  ]) @call_expr
"""

# JavaScript / TypeScript Queries
JS_IMPORT_QUERY = """
(import_statement
  source: (string) @import_source)

(variable_declarator
  value: (call_expression
    function: (identifier) @require_call (#eq? @require_call "require")
    arguments: (arguments (string) @import_source)))
"""

JS_CALL_QUERY = """
(call_expression
  function: [
    (identifier) @func_ident
    (member_expression
      object: [
        (identifier) @obj_ident
        (member_expression) @nested_obj
      ]
      property: (property_identifier) @prop_ident)
  ]) @call_expr
"""

# Rust Queries
RUST_IMPORT_QUERY = """
(use_declaration
  argument: [
    (scoped_identifier
      path: (identifier) @import_pkg)
    (use_as_clause
      path: (identifier) @import_pkg
      alias: (identifier) @import_alias)
    (use_list
      (scoped_identifier
        path: (identifier) @import_pkg))
  ])

(extern_crate_declaration
  name: (identifier) @import_pkg)
"""

RUST_CALL_QUERY = """
(call_expression
  function: [
    (identifier) @func_ident
    (field_expression
      value: (identifier) @obj_ident
      field: (field_identifier) @field_ident)
    (scoped_identifier
      path: (identifier) @scope_path
      name: (identifier) @scope_name)
  ]) @call_expr
"""


# ----------------------------------------------------------------------
# Universal AST Extractor
# ----------------------------------------------------------------------

class UniversalASTExtractor:
    EXT_MAPPING = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".rs": "rust",
    }

    IGNORE_DIRS = {
        ".git",
        "node_modules",
        "__pycache__",
        "target",
        ".venv",
        "venv",
        "env",
        "dist",
        "build",
    }

    def __init__(self):
        self._parsers: Dict[str, Parser] = {}
        self._languages: Dict[str, Language] = {}
        self._init_languages()

    def _init_languages(self):
        configs = {
            "python": (ts_py.language(), PY_IMPORT_QUERY, PY_CALL_QUERY),
            "javascript": (ts_js.language(), JS_IMPORT_QUERY, JS_CALL_QUERY),
            "typescript": (ts_ts.language_typescript(), JS_IMPORT_QUERY, JS_CALL_QUERY),
            "rust": (ts_rust.language(), RUST_IMPORT_QUERY, RUST_CALL_QUERY),
        }

        self.queries: Dict[str, Tuple[Query, Query]] = {}

        for lang_name, (lang_capsule, imp_q_str, call_q_str) in configs.items():
            lang = Language(lang_capsule)
            parser = Parser(lang)
            self._languages[lang_name] = lang
            self._parsers[lang_name] = parser
            self.queries[lang_name] = (
                lang.query(imp_q_str),
                lang.query(call_q_str),
            )

    def extract_usages(self, project_dir: Path, target_pkg: str) -> List[CallSite]:
        """Recursively scans files in project_dir for usages of target_pkg."""
        project_dir = project_dir.resolve()
        results: List[CallSite] = []

        # Standardize target names across ecosystems (e.g. rust-crypto vs rust_crypto)
        normalized_target = target_pkg.replace("-", "_").lower()

        for file_path in self._walk_files(project_dir):
            ext = file_path.suffix.lower()
            lang_key = self.EXT_MAPPING.get(ext)
            if not lang_key:
                continue

            try:
                code_bytes = file_path.read_bytes()
                call_sites = self._parse_file(
                    file_path=file_path,
                    code_bytes=code_bytes,
                    lang_key=lang_key,
                    target_pkg=target_pkg,
                    normalized_target=normalized_target,
                )
                results.extend(call_sites)
            except Exception:
                # Skip unparseable files, binary corruptions, or syntax errors
                continue

        return results

    def _walk_files(self, project_dir: Path):
        for path in project_dir.rglob("*"):
            if path.is_file():
                if any(part in self.IGNORE_DIRS for part in path.parts):
                    continue
                yield path

    def _parse_file(
        self,
        file_path: Path,
        code_bytes: bytes,
        lang_key: str,
        target_pkg: str,
        normalized_target: str,
    ) -> List[CallSite]:
        parser = self._parsers[lang_key]
        import_query, call_query = self.queries[lang_key]

        tree = parser.parse(code_bytes)
        root = tree.root_node

        # Step 1: Detect imported identifiers bound to target_pkg
        imported_symbols = self._find_imported_symbols(
            root, import_query, code_bytes, lang_key, target_pkg, normalized_target
        )

        if not imported_symbols:
            return []

        # Step 2: Extract all call expressions invoking imported identifiers
        return self._find_call_sites(
            root, call_query, code_bytes, file_path, imported_symbols
        )

    def _find_imported_symbols(
        self,
        root_node: Node,
        query: Query,
        code_bytes: bytes,
        lang_key: str,
        target_pkg: str,
        normalized_target: str,
    ) -> Set[str]:
        captures = query.captures(root_node)
        imported: Set[str] = set()

        if lang_key == "python":
            for node, name in captures:
                text = node.text.decode("utf-8", errors="ignore")
                base_pkg = text.split(".")[0]
                if base_pkg == target_pkg or base_pkg.replace("-", "_") == normalized_target:
                    imported.add(text)
                    imported.add(base_pkg)

        elif lang_key in ("javascript", "typescript"):
            for node, _ in captures:
                text = node.text.decode("utf-8", errors="ignore").strip("\"'`")
                if text == target_pkg or text.startswith(f"{target_pkg}/"):
                    # Find enclosing statement to resolve bound variable name
                    parent = node.parent
                    while parent and parent.type not in (
                        "import_statement",
                        "variable_declarator",
                    ):
                        parent = parent.parent
                    if parent:
                        imported.update(self._extract_js_imported_names(parent))

        elif lang_key == "rust":
            for node, _ in captures:
                text = node.text.decode("utf-8", errors="ignore")
                if text == target_pkg or text.replace("-", "_") == normalized_target:
                    parent = node.parent
                    if parent and parent.type == "use_as_clause":
                        alias_node = parent.child_by_field_name("alias")
                        if alias_node:
                            imported.add(alias_node.text.decode("utf-8", errors="ignore"))
                    else:
                        imported.add(text)

        return imported

    def _extract_js_imported_names(self, node: Node) -> Set[str]:
        names: Set[str] = set()
        for child in node.children:
            if child.type == "import_clause":
                names.update(self._extract_js_imported_names(child))
            elif child.type == "identifier":
                names.add(child.text.decode("utf-8", errors="ignore"))
            elif child.type == "named_imports":
                for spec in child.children:
                    if spec.type == "import_specifier":
                        alias = spec.child_by_field_name("alias")
                        name = alias if alias else spec.child_by_field_name("name")
                        if name:
                            names.add(name.text.decode("utf-8", errors="ignore"))
            elif child.type == "namespace_import":
                for sub in child.children:
                    if sub.type == "identifier":
                        names.add(sub.text.decode("utf-8", errors="ignore"))
        return names

    def _find_call_sites(
        self,
        root_node: Node,
        query: Query,
        code_bytes: bytes,
        file_path: Path,
        imported_symbols: Set[str],
    ) -> List[CallSite]:
        captures = query.captures(root_node)
        lines = code_bytes.decode("utf-8", errors="replace").splitlines()
        call_sites: List[CallSite] = []

        seen_positions: Set[Tuple[int, str]] = set()

        for node, capture_name in captures:
            if capture_name != "call_expr":
                continue

            full_call_str = node.text.decode("utf-8", errors="ignore")
            matched_symbol = None

            for sym in imported_symbols:
                # Check for `package.method()`, `alias()`, or `module::function()`
                if full_call_str.startswith(sym + ".") or \
                   full_call_str.startswith(sym + "(") or \
                   full_call_str.startswith(sym + "::"):
                    matched_symbol = sym
                    break

            if matched_symbol:
                start_line = node.start_point.row  # 0-indexed
                pos_key = (start_line, matched_symbol)
                if pos_key in seen_positions:
                    continue
                seen_positions.add(pos_key)

                # Capture call-site plus 2 surrounding lines (before & after)
                ctx_start = max(0, start_line - 2)
                ctx_end = min(len(lines), start_line + 3)
                context_block = "\n".join(lines[ctx_start:ctx_end])

                call_sites.append(
                    CallSite(
                        file_path=str(file_path),
                        line_number=start_line + 1,  # 1-indexed for display
                        invoked_symbol=node.text.decode("utf-8", errors="ignore").split("(")[0].strip(),
                        code_context=context_block,
                    )
                )

        return call_sites