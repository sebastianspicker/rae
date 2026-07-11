export function printUsage(phases) {
  process.stdout.write(`Usage: node scripts/pipeline/runner.mjs <command> [options]\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  run-stage       --run-id <id> --phase <phase> [options]\n`);
  process.stdout.write(`  start-phase     --run-id <id> --phase <phase>\n`);
  process.stdout.write(`  end-phase       --run-id <id> --phase <phase> [--status <ok|error>]\n`);
  process.stdout.write(
    `  record-artifact --run-id <id> --phase <phase> --artifact-ref <path> [--action <read|write>]\n`,
  );
  process.stdout.write(
    `  record-gate     --run-id <id> --phase <phase> --status <pass|fail|warn> [--gate-id <id>]\n`,
  );
  process.stdout.write(
    `  record-review-state --run-id <id> --state <explain|fix|ship> --status <status> [--note <text>]\n`,
  );
  process.stdout.write(
    `  summarize-run   --run-id <id> [--format <json|text|markdown>] [--output <path>]\n`,
  );
  process.stdout.write(
    `  summarize-progress --run-id <id> [--format <json|text|markdown>] [--output <path>]\n`,
  );
  process.stdout.write(`\nrun-stage options:\n`);
  process.stdout.write(`  --run-id <id>           Run identifier (from pipeline-init.sh)\n`);
  process.stdout.write(`  --phase <phase>         Pipeline phase to execute\n`);
  process.stdout.write(
    `  --config-id <id>        Configuration profile (default: phased_default)\n`,
  );
  process.stdout.write(`  --taskset <path>        Path to taskset JSON file\n`);
  process.stdout.write(`  --task-id <id>          Task within taskset (default: first task)\n`);
  process.stdout.write(
    `  --test-case-id <id>     Test case within the selected task (default: first test case)\n`,
  );
  process.stdout.write(`  --artifact-ref <path>   Override artifact output path\n`);
  process.stdout.write(`  --schema-ref <path>     Override schema reference\n`);
  process.stdout.write(
    `  --input-artifact <path> Read artifact from this path instead of generating\n`,
  );
  process.stdout.write(`  --gate-status <status>  Force gate status (pass|warn|fail)\n`);
  process.stdout.write(`\nPhases: ${phases.join(", ")}\n`);
}
