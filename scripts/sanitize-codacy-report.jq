# Removes workstation-specific paths and unstable metadata from Codacy reports.
{
  schemaVersion: 1,
  metadata: {
    startedAt: .metadata.startedAt,
    completedAt: .metadata.completedAt,
    durationMs: .metadata.durationMs,
    executionMode: .metadata.executionMode
  },
  toolResults: [
    .toolResults[]? |
    {toolId, status, issueCount, errorCount, durationMs, filesAnalyzed}
  ],
  issues: [
    .issues[]? |
    {toolId, patternId, filePath, line, column, endColumn, severity, category}
  ],
  errors: [
    .errors[]? |
    {toolId, filePath, kind, level, phase}
  ]
}
