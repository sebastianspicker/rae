from __future__ import annotations

import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "verify_repo.py"


def load_verify_repo_module():
    spec = importlib.util.spec_from_file_location("verify_repo", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_frontmatter_accepts_crlf(tmp_path: pathlib.Path) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    sample = docs_dir / "sample.md"
    sample.write_text(
        "---\r\nstatus: draft\r\nowner: core\r\nlast_reviewed: 2026-04-17\r\n"
        "source_of_truth: ../../README.md\r\n---\r\n\r\n# Sample\r\n",
        encoding="utf-8",
    )

    module.ROOT = tmp_path
    module.DOCS = docs_dir

    keys = module.parse_frontmatter(sample)
    assert {"status", "owner", "last_reviewed", "source_of_truth"}.issubset(keys)


def test_validate_links_rejects_repo_escape(tmp_path: pathlib.Path) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    (tmp_path / "README.md").write_text("# Root\n", encoding="utf-8")
    (tmp_path / "CONTRIBUTING.md").write_text("# Contrib\n", encoding="utf-8")
    (tmp_path / "SECURITY.md").write_text("# Security\n", encoding="utf-8")
    outside = tmp_path.parent / "outside-note.md"
    outside.write_text("# outside\n", encoding="utf-8")
    doc = docs_dir / "escape.md"
    doc.write_text(
        "---\nstatus: draft\nowner: core\nlast_reviewed: 2026-04-17\n"
        "source_of_truth: ../../README.md\n---\n\n[escape](../../outside-note.md)\n",
        encoding="utf-8",
    )

    module.ROOT = tmp_path
    module.DOCS = docs_dir

    try:
        module.validate_links()
    except ValueError as exc:
        assert "link escapes repository root" in str(exc)
    else:
        raise AssertionError(
            "validate_links should reject links escaping the repository root"
        )


def test_validate_links_skips_optional_missing_root_docs(
    tmp_path: pathlib.Path,
) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    (tmp_path / "README.md").write_text("# Root\n", encoding="utf-8")
    doc = docs_dir / "ok.md"
    doc.write_text(
        "---\nstatus: draft\nowner: core\nlast_reviewed: 2026-04-17\n"
        "source_of_truth: ../../README.md\n---\n\n[readme](../README.md)\n",
        encoding="utf-8",
    )

    module.ROOT = tmp_path
    module.DOCS = docs_dir

    module.validate_links()


def test_validate_doc_source_density_counts_unique_sources(
    tmp_path: pathlib.Path,
) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    doc = docs_dir / "sources.md"
    repeated = "\n".join(
        ["- [One](bibliography.md#src-one)"] * module.MIN_EXTERNAL_SOURCES
    )
    doc.write_text(
        "---\nstatus: draft\nowner: core\nlast_reviewed: 2026-04-17\n"
        "source_of_truth: editorial\n---\n\n"
        f"{repeated}\n",
        encoding="utf-8",
    )

    module.ROOT = tmp_path
    module.DOCS = docs_dir

    try:
        module.validate_doc_source_density()
    except ValueError as exc:
        assert "external sources" in str(exc)
    else:
        raise AssertionError(
            "validate_doc_source_density should require unique sources"
        )
