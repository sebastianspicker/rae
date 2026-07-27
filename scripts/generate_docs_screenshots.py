#!/usr/bin/env python3
"""Generate deterministic SVG terminal captures for public documentation."""

import argparse
import html
import os
import pathlib
import subprocess
import sys
import textwrap
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCREENSHOT_DIR = ROOT / "docs" / "assets" / "screenshots"


@dataclass(frozen=True)
class Capture:
    filename: str
    title: str
    prompt: str
    argv: tuple[str, ...]


CAPTURES = (
    Capture(
        "rae-cli.svg",
        "RAE command map",
        "$ ./scripts/rae.sh --help",
        (str(ROOT / "scripts" / "rae.sh"), "--help"),
    ),
    Capture(
        "rae-agent-safety.svg",
        "RAE autonomous agent safety defaults",
        "$ ./scripts/rae.sh agent --help",
        (str(ROOT / "scripts" / "rae.sh"), "agent", "--help"),
    ),
)


def capture_output(capture: Capture) -> str:
    env = os.environ.copy()
    env.update({"LANG": "C", "LC_ALL": "C", "NO_COLOR": "1"})
    completed = subprocess.run(  # noqa: S603
        capture.argv,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    output = (completed.stdout + completed.stderr).replace(str(ROOT), "/path/to/rae")
    return output.rstrip()


def render_svg(capture: Capture, output: str) -> str:
    lines = [capture.prompt, "", *wrapped_output_lines(output)]
    longest = max(len(line) for line in lines)
    width = min(1600, max(960, longest * 9 + 80))
    height = 88 + len(lines) * 22
    text_nodes = [
        f'    <text x="32" y="{76 + index * 22}" class="line">{html.escape(line)}</text>'
        for index, line in enumerate(lines)
    ]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        'role="img" aria-labelledby="title description">\n'
        f'  <title id="title">{html.escape(capture.title)}</title>\n'
        '  <desc id="description">Deterministic terminal capture generated from the live RAE CLI.</desc>\n'
        "  <style>\n"
        "    .line { fill: #e6edf3; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n"
        "    .chrome { fill: #8b949e; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n"
        "  </style>\n"
        f'  <rect width="{width}" height="{height}" rx="14" fill="#0d1117"/>\n'
        f'  <rect width="{width}" height="44" rx="14" fill="#161b22"/>\n'
        '  <circle cx="24" cy="22" r="6" fill="#ff5f56"/>\n'
        '  <circle cx="44" cy="22" r="6" fill="#ffbd2e"/>\n'
        '  <circle cx="64" cy="22" r="6" fill="#27c93f"/>\n'
        f'  <text x="88" y="27" class="chrome">{html.escape(capture.title)}</text>\n'
        + "\n".join(text_nodes)
        + "\n</svg>\n"
    )


def wrapped_output_lines(output: str) -> list[str]:
    wrapper = textwrap.TextWrapper(
        width=118,
        subsequent_indent="    ",
        replace_whitespace=False,
        drop_whitespace=False,
    )
    return [
        wrapped
        for line in output.splitlines()
        for wrapped in (wrapper.wrap(line) if line else [""])
    ]


def generate(check: bool) -> int:
    stale: list[pathlib.Path] = []
    for capture in CAPTURES:
        target = SCREENSHOT_DIR / capture.filename
        expected = render_svg(capture, capture_output(capture))
        if check:
            if not target.is_file() or target.read_text(encoding="utf-8") != expected:
                stale.append(target)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(expected, encoding="utf-8")
    for path in stale:
        print(f"stale generated screenshot: {path.relative_to(ROOT)}", file=sys.stderr)
    return 1 if stale else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail when committed assets are stale")
    return parser.parse_args()


def main() -> int:
    return generate(parse_args().check)


if __name__ == "__main__":
    raise SystemExit(main())
