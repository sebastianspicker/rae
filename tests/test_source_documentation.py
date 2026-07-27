"""Contract tests for the language-aware source documentation header check."""

import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_source_documentation.py"


def load_module():
    """Load the script directly so tests cover the same release-gate code path."""
    spec = importlib.util.spec_from_file_location("check_source_documentation", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_python_requires_module_docstring(tmp_path: pathlib.Path) -> None:
    module = load_module()
    module.__dict__["ROOT"] = tmp_path
    path = tmp_path / "scripts" / "sample.py"
    path.parent.mkdir()

    assert module.has_source_header(path, '"""Explain the module purpose."""\nVALUE = 1\n')
    assert not module.has_source_header(path, "VALUE = 1\n")


def test_shell_skips_shebang_and_shellcheck_directives(tmp_path: pathlib.Path) -> None:
    module = load_module()
    module.__dict__["ROOT"] = tmp_path
    path = tmp_path / "scripts" / "sample.sh"
    path.parent.mkdir()
    text = (
        "#!/usr/bin/env bash\n"
        "# shellcheck shell=bash\n"
        "# Enforce one shared runtime contract for every shell entrypoint.\n"
        "set -euo pipefail\n"
    )

    assert module.has_source_header(path, text)


def test_javascript_requires_comment_before_imports(tmp_path: pathlib.Path) -> None:
    module = load_module()
    module.__dict__["ROOT"] = tmp_path
    path = tmp_path / "packages" / "sample.mjs"
    path.parent.mkdir()

    assert module.has_source_header(
        path, "/** Coordinate the pipeline phases. */\nimport fs from 'fs';\n"
    )
    assert not module.has_source_header(path, "import fs from 'fs';\n")


def test_declarative_formats_are_outside_the_source_header_gate(
    tmp_path: pathlib.Path,
) -> None:
    module = load_module()
    module.__dict__["ROOT"] = tmp_path
    path = tmp_path / "packages" / "schema.json"
    path.parent.mkdir()

    assert module.has_source_header(path, "{}\n")


def test_binary_assets_are_skipped_before_text_decoding(tmp_path: pathlib.Path) -> None:
    module = load_module()
    module.__dict__["ROOT"] = tmp_path
    path = tmp_path / "docs" / "concept.png"
    path.parent.mkdir()
    path.write_bytes(b"\x89PNG\r\n\x1a\n")

    assert module.missing_source_headers([path]) == []
