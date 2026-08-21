# Testing

RAE keeps a compact regression suite around execution safety and protocol
contracts. It avoids fixtures, generated outputs, and grading infrastructure.

Run the documented local gate after dependencies are installed:

```bash
./scripts/verify.sh --skip-install
```

The retained checks cover the root runtime contract, evaluator validation and
CLI smoke paths, Ralph scope, transaction, runtime-state, security, and JSON
contracts, plus orchestration argv, event-log, state, and loopback security
boundaries.

Focused commands:

```bash
bash packages/loops/ralph/scripts/run_tests.sh
npm --prefix packages/orchestration run test:operator
npm --prefix packages/orchestration run test:runner
```
