/** Emits final autonomous CLI output after report generation. */
export { writeRunReport } from "./run-report-writer.mjs";

export function printFinal(context, report, options, error = null) {
  const payload = {
    success: !error,
    status: report.status,
    run_id: context.runId,
    workspace_root: context.workspaceRoot,
    report: report.reportPath,
    cleanup_command: report.cleanupCommand,
    changed_files: report.changes,
    documentation: report.docs,
    ...(error ? { error: error.message } : {}),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `RAE autonomous run: ${payload.status}`,
      `run_id:        ${payload.run_id}`,
      `workspace:     ${payload.workspace_root}`,
      `changed_files: ${payload.changed_files.length}`,
      `report:        ${payload.report}`,
      ...(payload.cleanup_command ? [`cleanup:       ${payload.cleanup_command}`] : []),
      ...(error ? [`error:         ${error.message}`] : []),
      "",
    ].join("\n"),
  );
}
