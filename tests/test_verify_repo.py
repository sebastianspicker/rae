"""Regression tests for repository-publication verification helpers."""

import importlib.util
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "verify_repo.py"


def load_verify_repo_module():
    spec = importlib.util.spec_from_file_location("verify_repo", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    """Build one PNG chunk with its declared length and CRC."""
    crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", crc)


def build_test_png(width: int, height: int) -> bytes:
    """Build a minimal chunk-valid PNG fixture for publication checks."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + build_png_chunk(b"IHDR", header)
        + build_png_chunk(b"IDAT", zlib.compress(b"\x00"))
        + build_png_chunk(b"IEND", b"")
    )


def test_parse_args_supports_named_partial_mkdocs_mode() -> None:
    module = load_verify_repo_module()

    assert module.parse_args([]).skip_mkdocs is False
    assert module.parse_args(["--skip-mkdocs"]).skip_mkdocs is True
    assert module.parse_args(["--release-candidate"]).release_candidate is True


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

    module.__dict__["ROOT"] = tmp_path
    module.__dict__["DOCS"] = docs_dir

    keys = module.parse_frontmatter(sample)
    assert {"status", "owner", "last_reviewed", "source_of_truth"}.issubset(keys)


def test_iter_markdown_files_excludes_local_docs(
    tmp_path: pathlib.Path,
) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    public_doc = docs_dir / "reference" / "public.md"
    agent_doc = docs_dir / "agent" / "private-ledger.md"
    archive_doc = docs_dir / "archive" / "retired-plan.md"
    public_doc.parent.mkdir(parents=True)
    agent_doc.parent.mkdir(parents=True)
    archive_doc.parent.mkdir(parents=True)
    public_doc.write_text("# Public\n", encoding="utf-8")
    agent_doc.write_text("# Local\n", encoding="utf-8")
    archive_doc.write_text("# Retired\n", encoding="utf-8")

    module.__dict__["ROOT"] = tmp_path
    module.__dict__["DOCS"] = docs_dir

    assert module.iter_markdown_files() == [public_doc]


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

    module.__dict__["ROOT"] = tmp_path
    module.__dict__["DOCS"] = docs_dir

    try:
        module.validate_links()
    except ValueError as exc:
        assert "link escapes repository root" in str(exc)
    else:
        raise AssertionError("validate_links should reject links escaping the repository root")


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

    module.__dict__["ROOT"] = tmp_path
    module.__dict__["DOCS"] = docs_dir

    module.validate_links()


def test_required_files_include_public_alpha_surface() -> None:
    module = load_verify_repo_module()

    assert {
        "CHANGELOG.md",
        "CODE_OF_CONDUCT.md",
        "GOVERNANCE.md",
        "RELEASING.md",
        "RELEASE_NOTES.md",
        "RELEASE_STATUS.md",
        "SUPPORT.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/ISSUE_TEMPLATE/documentation.yml",
        "docs/assets/brand/rae-mark.svg",
        "docs/assets/brand/rae-social-preview.png",
        "docs/assets/screenshots/rae-cli.svg",
        "docs/stylesheets/brand.css",
    }.issubset(module.REQUIRED_PUBLIC_FILES)
    assert "scripts/check_source_documentation.py" in module.REQUIRED_REPOSITORY_FILES


def test_release_candidate_git_state_rejects_dirty_worktree() -> None:
    module = load_verify_repo_module()

    try:
        module.validate_release_candidate_git_state(
            status_output=b"?? CHANGELOG.md\0",
            tracked_relatives=set(module.REQUIRED_REPOSITORY_FILES),
        )
    except ValueError as exc:
        assert "Git worktree is not clean" in str(exc)
        assert "CHANGELOG.md" in str(exc)
    else:
        raise AssertionError("release candidate mode must reject dirty worktrees")


def test_release_candidate_git_state_requires_tracked_release_files() -> None:
    module = load_verify_repo_module()
    tracked = set(module.REQUIRED_REPOSITORY_FILES) - {"RELEASE_STATUS.md"}

    try:
        module.validate_release_candidate_git_state(
            status_output=b"",
            tracked_relatives=tracked,
        )
    except ValueError as exc:
        assert "release-required files are not tracked" in str(exc)
        assert "RELEASE_STATUS.md" in str(exc)
    else:
        raise AssertionError("release candidate mode must reject untracked required files")


def test_obsolete_public_artifacts_reject_live_working_docs(tmp_path: pathlib.Path) -> None:
    module = load_verify_repo_module()
    stale = tmp_path / "docs" / "agent" / "codacy-remediation-ledger.md"
    stale.parent.mkdir(parents=True)
    stale.write_text("# stale\n", encoding="utf-8")

    module.__dict__["ROOT"] = tmp_path

    try:
        module.validate_no_obsolete_public_artifacts([stale])
    except ValueError as exc:
        assert "obsolete public artifacts remain" in str(exc)
    else:
        raise AssertionError("local agent ledgers must not enter the public candidate")


def test_obsolete_public_artifacts_allow_product_ledgers(tmp_path: pathlib.Path) -> None:
    module = load_verify_repo_module()
    claims = tmp_path / "docs" / "reference" / "claims" / "claims-ledger.md"
    contract = tmp_path / "docs" / "reference" / "contracts" / "result-ledger.md"
    claims.parent.mkdir(parents=True)
    contract.parent.mkdir(parents=True)
    claims.write_text("# claims\n", encoding="utf-8")
    contract.write_text("# contract\n", encoding="utf-8")

    module.__dict__["ROOT"] = tmp_path

    module.validate_no_obsolete_public_artifacts([claims, contract])


def test_obsolete_public_artifacts_reject_root_release_work_files(
    tmp_path: pathlib.Path,
) -> None:
    module = load_verify_repo_module()
    stale = tmp_path / "CODEBASE_AUDIT_2026-07-16.md"
    release_status = tmp_path / "RELEASE_STATUS.md"
    stale.write_text("# stale\n", encoding="utf-8")
    release_status.write_text("# release\n", encoding="utf-8")

    module.__dict__["ROOT"] = tmp_path

    try:
        module.validate_no_obsolete_public_artifacts([stale, release_status])
    except ValueError as exc:
        assert "CODEBASE_AUDIT_2026-07-16.md" in str(exc)
        assert "RELEASE_STATUS.md" not in str(exc)
    else:
        raise AssertionError("root audit work files must not enter the public candidate")


def test_validate_svg_text_rejects_private_workstation_paths() -> None:
    module = load_verify_repo_module()
    text = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        "<desc>Deterministic terminal capture from /Users/alice/repo</desc></svg>"
    )

    try:
        module.validate_svg_text(text, "docs/assets/screenshots/example.svg")
    except ValueError as exc:
        assert "private workstation path" in str(exc)
    else:
        raise AssertionError("generated screenshots must not expose private paths")


def test_validate_svg_text_rejects_malformed_xml() -> None:
    module = load_verify_repo_module()

    try:
        module.validate_svg_text(
            "<svg><desc>Deterministic terminal capture</svg>",
            "docs/assets/screenshots/example.svg",
        )
    except ValueError as exc:
        assert "not valid SVG XML" in str(exc)
    else:
        raise AssertionError("generated screenshots must be valid SVG XML")


def test_validate_svg_text_rejects_xml_declarations() -> None:
    module = load_verify_repo_module()

    try:
        module.validate_svg_text(
            "<!DOCTYPE svg><svg><desc>Deterministic terminal capture</desc></svg>",
            "docs/assets/screenshots/example.svg",
        )
    except ValueError as exc:
        assert "unsafe or unexpectedly large XML" in str(exc)
    else:
        raise AssertionError("generated screenshots must reject XML declarations")


def test_validate_brand_svg_requires_accessible_metadata_and_viewbox() -> None:
    module = load_verify_repo_module()
    valid = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<title>RAE mark</title><desc>Evidence trace</desc><path d="M0 0h1"/></svg>'
    )

    module.validate_brand_svg(valid, "docs/assets/brand/example.svg")

    try:
        module.validate_brand_svg(
            '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>',
            "docs/assets/brand/example.svg",
        )
    except ValueError as exc:
        assert "title and description" in str(exc)
    else:
        raise AssertionError("brand SVGs must include accessible metadata")


def test_validate_brand_svg_rejects_active_and_external_content() -> None:
    module = load_verify_repo_module()
    prefix = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        "<title>RAE mark</title><desc>Evidence trace</desc>"
    )

    for payload, expected in (
        ("<script>void 0</script>", "active or embedded"),
        ('<path onclick="void 0"/>', "event handler"),
        ('<a href="https://example.com"><path/></a>', "external SVG reference"),
        ('<style>@import url("https://example.com/font.css")</style>', "style reference"),
        (
            "<style>.a{fill:url(#ok);background:url(https://example.com/x)}</style>",
            "style reference",
        ),
    ):
        try:
            module.validate_brand_svg(
                f"{prefix}{payload}</svg>",
                "docs/assets/brand/example.svg",
            )
        except ValueError as exc:
            assert expected in str(exc)
        else:
            raise AssertionError(f"brand SVG should reject {payload}")


def test_validate_social_preview_png_enforces_size_and_dimensions() -> None:
    module = load_verify_repo_module()
    valid = build_test_png(1280, 640)

    module.validate_social_preview_png(valid, "docs/assets/brand/preview.png")

    try:
        module.validate_social_preview_png(
            build_test_png(640, 320),
            "docs/assets/brand/preview.png",
        )
    except ValueError as exc:
        assert "must be 1280x640px" in str(exc)
    else:
        raise AssertionError("social preview dimensions must be exact")

    try:
        module.validate_social_preview_png(
            valid + b"x" * module.MAX_SOCIAL_PREVIEW_BYTES,
            "docs/assets/brand/preview.png",
        )
    except ValueError as exc:
        assert "smaller than 1 MB" in str(exc)
    else:
        raise AssertionError("social preview size limit must be enforced")

    truncated = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", 1280, 640)
    try:
        module.validate_social_preview_png(
            truncated,
            "docs/assets/brand/preview.png",
        )
    except ValueError as exc:
        assert "truncated PNG chunk" in str(exc)
    else:
        raise AssertionError("truncated social preview PNGs must be rejected")

    duplicate_end = valid[:33] + build_png_chunk(b"IEND", b"") + valid[33:]
    try:
        module.validate_social_preview_png(
            duplicate_end,
            "docs/assets/brand/preview.png",
        )
    except ValueError as exc:
        assert "non-terminal PNG IEND chunk" in str(exc)
    else:
        raise AssertionError("non-terminal PNG IEND chunks must be rejected")


def test_validate_doc_source_density_counts_unique_sources(
    tmp_path: pathlib.Path,
) -> None:
    module = load_verify_repo_module()
    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    doc = docs_dir / "sources.md"
    repeated = "\n".join(["- [One](bibliography.md#src-one)"] * module.MIN_EXTERNAL_SOURCES)
    doc.write_text(
        "---\nstatus: draft\nowner: core\nlast_reviewed: 2026-04-17\n"
        "source_of_truth: editorial\n---\n\n"
        f"{repeated}\n",
        encoding="utf-8",
    )

    module.__dict__["ROOT"] = tmp_path
    module.__dict__["DOCS"] = docs_dir

    try:
        module.validate_doc_source_density()
    except ValueError as exc:
        assert "external sources" in str(exc)
    else:
        raise AssertionError("validate_doc_source_density should require unique sources")
