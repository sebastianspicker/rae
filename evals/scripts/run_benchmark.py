#!/usr/bin/env python3
"""Execute benchmark tasks through the umbrella runtimes and emit artifacts."""

from lib.run_benchmark_exec import judge_task
from lib.run_benchmark_report import main

__all__ = ["judge_task", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
