# Testing

RAE is a monorepo. Tests stay with the component that owns the behavior, while
the root verifier runs the complete integrated suite. This preserves
package-relative fixtures, dynamic shell discovery, and independently runnable
package checks.

## Complete gate

For a checkout with declared dependencies already installed:

```bash
./scripts/verify.sh --skip-install
```

Use `./scripts/verify.sh` when the verifier should install dependencies.
`--skip-mkdocs` is a partial documentation mode and is not release evidence.

The root gate runs:

- repository metadata, documentation, screenshot, and hygiene validation
- Python compilation, Ruff, Pyright, Lizard, and Pytest
- the root runtime contract
- evaluation and profile checks
- orchestration builds and tests
- Ralph tests
- repository hygiene tool tests
- ShellCheck

## Test inventory

The current tree contains 128 executable test source files and 11 referenced
runner, helper, fixture, or configuration files.

| Classification | Paths | Count | Runner or owner |
| --- | --- | ---: | --- |
| Active | `tests/test_*.py` | 2 | `python -m pytest evals/tests tests` |
| Active | `tests/runtime-contract.sh` | 1 | `scripts/verify.sh` |
| Active | `evals/tests/test_*.py` | 9 | Pytest through the root verifier |
| Active support | `evals/tests/benchmark_contracts_helpers.py`, `evals/tests/outcome_optimizer_helpers.py` | 2 | Imported by evaluation tests |
| Experimental | `evals/fixtures/autonomous-outcomes/*/tests/test_*.py` | 3 | Outcome evaluator fixture manifests |
| Active | `packages/loops/ralph/tests/ralph_*_test.sh` | 63 | `packages/loops/ralph/scripts/run_tests.sh` |
| Active support | Ralph test runner and `tests/lib/test_helpers.sh` | 2 | Ralph shell suite |
| Active | `packages/orchestration/operator/tests/*.test.mjs` | 5 | Node test runner |
| Active | `packages/orchestration/scripts/pipeline/tests/*.test.mjs` | 25 | Vitest |
| Active support | Pipeline Vitest config, test helper, and two fixture modules | 4 | Pipeline Vitest suite |
| Active | `packages/orchestration/skills/dev-tools/*/tests/unit/*.test.ts` | 17 | Package-local Vitest commands |
| Active support | `trace-test-helpers.ts` | 1 | Trace collector tests |
| Active | `profiles/agent-environments/tests/profile-installation.sh` | 1 | Root verifier |
| Active | `tools/repo-hygiene/coauthor-trailer-cleaner/tests/test-*.sh` | 2 | Tool test runner |
| Active support | Hygiene test runner and `helpers.sh` | 2 | Hygiene shell suite |

The three experimental Python tests are committed benchmark fixture source.
They are intentionally excluded from normal Pytest collection and must remain
beside their evaluator fixtures.

Three evaluation modules set `__test__ = False` and are imported by
`test_outcome_optimizer.py`. They split the implementation of that suite
without creating duplicate Pytest collection:

- `test_outcome_execution_safety.py`
- `test_outcome_comparison_integrity.py`
- `test_policy_optimizer_contracts.py`

No current test source is classified as obsolete, duplicated, incomplete, or
no longer relevant. No current test source is machine-produced.

## Focused commands

Root Python and runtime tests:

```bash
python -m pytest evals/tests tests
bash tests/runtime-contract.sh
```

Orchestration:

```bash
npm --prefix packages/orchestration run test:operator
npm --prefix packages/orchestration run test:runner
npm --prefix packages/orchestration run verify
```

Ralph:

```bash
bash packages/loops/ralph/scripts/run_tests.sh
```

Profile installation:

```bash
bash profiles/agent-environments/tests/profile-installation.sh
```

Repository hygiene tool:

```bash
bash tools/repo-hygiene/coauthor-trailer-cleaner/tests/run-tests.sh
```

## Test artifacts

The repository ignores test outputs rather than test source. Existing rules
cover:

- `coverage/`, `htmlcov/`, `.coverage*`, and `coverage.xml`
- `junit.xml` and `reports/`
- `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.vitest/`, and
  `__pycache__/`
- `.venv/`, `.tox/`, `.nox/`, `node_modules/`, and package-manager caches
- `playwright-report/` and `test-results/`
- local evaluation results, `.pipeline/`, and `.runtime/`

Do not add `tests/`, package test directories, committed benchmark fixtures, or
committed baselines to `.gitignore`.

## Adding tests

- Put repository-wide Python and shell contract tests in `tests/`.
- Put package tests in the owning package's `tests/` directory.
- Keep TypeScript unit tests under the owning workspace's `tests/unit/`.
- Keep evaluator-only tests beside the fixture they execute.
- Update the owning runner, package script, and root verifier when a new test
  pattern is introduced.
- Keep temporary output outside the source tree or under an ignored
  framework-specific artifact directory.
