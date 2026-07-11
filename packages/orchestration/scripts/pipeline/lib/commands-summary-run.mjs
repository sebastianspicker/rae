export function runSummaryView(runId, summary, phases) {
  const durations = summary.phase_durations_ms ?? {};
  return {
    runId,
    summary,
    display: summaryDisplay(summary),
    issues: summaryIssues(summary),
    durations,
    phases: phases.filter((phase) => durations[phase] !== undefined),
    gates: normalizedGates(summary.gate_results),
  };
}

function summaryDisplay(summary) {
  return {
    valid: booleanText(summary.valid),
    events: zeroValue(summary.total_events),
    duration: summaryDuration(summary),
    cost: zeroValue(summary.total_cost_usd),
    tokensIn: zeroValue(summary.total_tokens_in),
    tokensOut: zeroValue(summary.total_tokens_out),
  };
}

const booleanText = (value) => (value ? "true" : "false");
const zeroValue = (value) => value ?? 0;
const summaryDuration = (summary) =>
  summary.summed_phase_duration_s ?? summary.total_duration_s ?? 0;

const summaryIssues = (summary) => (Array.isArray(summary.issues) ? summary.issues : []);

function normalizedGates(gateResults = {}) {
  return {
    pass: gateResults.pass ?? 0,
    warn: gateResults.warn ?? 0,
    fail: gateResults.fail ?? 0,
  };
}

export function renderRunSummary(view, format) {
  return format === "text" ? renderText(view) : renderMarkdown(view);
}

function renderText(view) {
  const { runId, summary, display, issues, durations, phases, gates } = view;
  return [
    `Run summary: ${runId}`,
    `valid: ${display.valid}`,
    `events: ${display.events}`,
    `gates: pass=${gates.pass} warn=${gates.warn} fail=${gates.fail}`,
    `duration_s: ${display.duration}`,
    ...(summary.total_wall_clock_s !== undefined
      ? [`wall_clock_s: ${summary.total_wall_clock_s}`]
      : []),
    `cost_usd: ${display.cost}`,
    `tokens: in=${display.tokensIn} out=${display.tokensOut}`,
    issues.length ? `issues (${issues.length}):` : "issues: none",
    ...(issues.length ? issues.map((issue) => `  - ${issue}`) : []),
    phases.length ? "phase_durations_ms:" : "phase_durations_ms: none",
    ...phases.map((phase) => `  - ${phase}: ${durations[phase]} ms`),
    "",
  ].join("\n");
}

function renderMarkdown(view) {
  const { runId, summary, display, issues, durations, phases, gates } = view;
  return [
    `# Run Summary: ${runId}`,
    "",
    `- Valid: \`${display.valid}\``,
    `- Total events: \`${display.events}\``,
    `- Gates: pass=\`${gates.pass}\`, warn=\`${gates.warn}\`, fail=\`${gates.fail}\``,
    `- Duration (s): \`${display.duration}\``,
    ...wallClock(summary),
    `- Cost (USD): \`${display.cost}\``,
    `- Tokens: in=\`${display.tokensIn}\`, out=\`${display.tokensOut}\``,
    "",
    "## Phase Durations",
    "",
    "| Phase | Duration (ms) |",
    "| --- | ---: |",
    ...phaseRows(phases, durations),
    "",
    "## Issues",
    "",
    ...issueRows(issues),
    "",
  ].join("\n");
}

const wallClock = (summary) =>
  summary.total_wall_clock_s === undefined
    ? []
    : [`- Wall clock (s): \`${summary.total_wall_clock_s}\``];
const phaseRows = (phases, durations) =>
  phases.length ? phases.map((phase) => `| ${phase} | ${durations[phase]} |`) : ["| (none) | 0 |"];
const issueRows = (issues) => (issues.length ? issues.map((issue) => `- ${issue}`) : ["- None"]);
