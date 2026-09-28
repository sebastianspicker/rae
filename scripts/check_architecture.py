#!/usr/bin/env python3

"""Enforce the dependency boundaries of the reconstructed RAE repository."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"}
LEGACY_ROOTS = ("packages/orchestration/", "packages/loops/")
ENGINE_SOURCE_IMPORT = re.compile(r"packages/engine/src/")
IMPORT_TARGET = re.compile(r"(?:from\s+|import\s*(?:\(\s*)?)[\"']([^\"']+)[\"']")
ENGINE_FORBIDDEN_TARGET = re.compile(
    r"(?:^|/)(?:apps|packages/ralph|packages/dev-tools|integrations)/"
)


def tracked_files() -> list[Path]:
    git_bin = shutil.which("git")
    if git_bin is None:
        raise RuntimeError("git is required for architecture checks")
    output = subprocess.check_output(  # noqa: S603
        [git_bin, "-C", str(ROOT), "ls-files", "-co", "--exclude-standard"],
        text=True,
        encoding="utf-8",
    )
    paths = [Path(line) for line in output.splitlines() if line]
    return [path for path in paths if (ROOT / path).exists()]


def source_text(path: Path) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def violations() -> list[str]:
    errors: list[str] = []
    files = tracked_files()
    for path in files:
        value = path.as_posix()
        if value.startswith(LEGACY_ROOTS):
            errors.append(f"legacy architecture path remains: {value}")
        if path.suffix not in SOURCE_SUFFIXES:
            continue
        text = source_text(path)
        if value.startswith(("apps/operator/", "apps/platform/")) and ENGINE_SOURCE_IMPORT.search(
            text
        ):
            errors.append(f"app bypasses @rae/engine public export: {value}")
        if value.startswith("packages/engine/"):
            imports = (match.group(1) for match in IMPORT_TARGET.finditer(text))
            if any(ENGINE_FORBIDDEN_TARGET.search(target) for target in imports):
                errors.append(f"engine imports an outer application/tool source: {value}")

    required = {
        "packages/contracts/package.json",
        "packages/engine/src/public/index.mjs",
        "apps/operator/package.json",
        "apps/platform/package.json",
        "workflows/graph-native-default.workflow.json",
        "integrations/agent-adapters/content/spec/adapter-manifest.json",
    }
    present = {path.as_posix() for path in files}
    errors.extend(
        f"required architecture boundary missing: {path}" for path in sorted(required - present)
    )
    return errors


def main() -> int:
    errors = violations()
    if errors:
        print("FAIL: architecture boundary violations")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: architecture boundaries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
