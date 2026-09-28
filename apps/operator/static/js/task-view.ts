/** Presents the task journey using only sanitized, recorded run evidence. */
import type { OperatorEvent, OperatorRun } from "./types.js";
import { formatTime, humanize, tone } from "./format.js";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = "Not recorded"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}
function reference(value: string, label: string): HTMLElement {
  const row = element("div", "", "reference-row");
  const copy = element("button", label);
  copy.type = "button";
  copy.dataset.copyReference = value;
  row.append(element("code", value), copy);
  return row;
}
export function taskCompleted(run: OperatorRun): boolean {
  return run.status === "completed" && !run.controls?.resume && !run.runtime_active;
}
function evidenceRows(run: OperatorRun): Array<[string, string]> {
  const instances = record(run.workflow).instances;
  if (Array.isArray(instances) && instances.length) {
    return instances.map((value) => {
      const instance = record(value);
      return [text(instance.node_id ?? instance.instance_id), humanize(text(instance.status))];
    });
  }
  if (run.workflow) {
    return (run.gates ?? [])
      .filter((gate) => gate.artifact_ref)
      .map((gate) => [gate.artifact_ref ?? "Not recorded", "Reference recorded"]);
  }
  return (run.gates ?? []).map((gate) => [
    gate.phase ?? gate.gate_id ?? "Unnamed gate",
    humanize(gate.status ?? "Not recorded"),
  ]);
}
function evidenceTable(run: OperatorRun): HTMLElement {
  const rows = evidenceRows(run);
  if (!rows.length)
    return element("p", "No workflow outcomes or gate records have been projected yet.", "note");
  const table = element("table", "", "record-table");
  const head = element("thead");
  const header = element("tr");
  for (const title of ["Evidence", "State"]) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  head.append(header);
  const body = element("tbody");
  for (const [name, status] of rows) {
    const row = element("tr");
    row.append(element("td", name), element("td", status));
    body.append(row);
  }
  table.append(head, body);
  return table;
}
function checkpointRecord(run: OperatorRun): HTMLElement {
  const region = element("section", "", "checkpoint-record");
  region.append(element("h4", "Checkpoint record"));
  const decisions = (run.checkpoints ?? []).filter((item) => item.status !== "pending");
  if (!decisions.length) region.append(element("p", "No checkpoint decision has been recorded."));
  for (const checkpoint of decisions) {
    const decision = record(checkpoint.decision);
    const purpose =
      checkpoint.purpose === "ship" ? "Before release" : text(checkpoint.phase, "Checkpoint");
    const actor = text(decision.actor ?? checkpoint.actor, "actor unavailable");
    region.append(
      element("p", `${purpose} · ${humanize(checkpoint.status ?? "unknown")} · ${actor}`),
    );
  }
  return region;
}
type JourneyState = "done" | "current" | "hold" | "halted" | "skipped" | "todo";

const JOURNEY: Array<{ label: string; notes: Partial<Record<JourneyState, string>> }> = [
  { label: "Task", notes: { done: "written" } },
  {
    label: "Checkpoint",
    notes: {
      done: "decided",
      hold: "your decision",
      skipped: "none recorded",
      todo: "not reached",
    },
  },
  { label: "Execution", notes: { done: "recorded", current: "in progress", todo: "not started" } },
  { label: "Hand-off", notes: { current: "review locally", todo: "after completion" } },
];

function journeyState(
  run: OperatorRun,
  index: number,
  active: number,
  done: boolean,
  pending: boolean,
): JourneyState {
  if (done) return "done";
  if (index < active) return "skipped";
  if (index !== active) return "todo";
  if (pending && index === 1) return "hold";
  // A stopped or interrupted run that can resume is paused, not failed.
  if (run.controls?.resume) return "current";
  return index === 2 && !run.runtime_active && ["error", "muted"].includes(tone(run.status))
    ? "halted"
    : "current";
}

function journeyNote(run: OperatorRun, index: number, stepState: JourneyState): string {
  if (stepState === "halted") return humanize(run.status ?? "stopped").toLowerCase();
  if (index === 2 && stepState === "current" && run.controls?.resume) return "ready to resume";
  return JOURNEY[index]?.notes[stepState] ?? "";
}

/** Draws the run journey as the mark's stepped trace; state comes only from recorded run data. */
function journey(run: OperatorRun): void {
  const steps = document.getElementById("task-steps");
  if (!steps) return;
  const pending = Boolean(run.checkpoints?.some((item) => item.status === "pending"));
  const completed = taskCompleted(run);
  const active = completed ? 3 : pending ? 1 : 2;
  const reviewed = run.checkpoints?.some((item) =>
    ["approved", "approve"].includes(item.status ?? ""),
  );
  steps.replaceChildren(
    ...JOURNEY.map(({ label }, index) => {
      const step = element("li");
      const done =
        index === 0 || (index === 1 && reviewed && !pending) || (index === 2 && completed);
      const stepState = journeyState(run, index, active, Boolean(done), pending);
      const note = journeyNote(run, index, stepState);
      const mark = element("span", "", "trace__mark");
      mark.setAttribute("aria-hidden", "true");
      step.dataset.state = stepState;
      step.append(mark, element("span", label, "trace__label"));
      if (note) step.append(element("span", note, "trace__note"));
      if (index === active) step.setAttribute("aria-current", "step");
      return step;
    }),
  );
}
function evidenceCopy(
  run: OperatorRun,
  pending: NonNullable<OperatorRun["checkpoints"]>[number] | undefined,
): [string, string] {
  if (taskCompleted(run)) return ["Run completed.", "Implementation awaits human release review."];
  if (pending)
    return [
      pending.purpose === "ship" ? "Review before release" : "Review before code changes",
      "Review the saved evidence locally, then record your decision.",
    ];
  if (run.controls?.resume)
    return [
      "Ready to resume.",
      "Resume is a separate action. Review the checkpoint record and current run state first.",
    ];
  return ["Execution evidence", "Recorded run state updates as the workflow progresses."];
}
function evidenceTone(run: OperatorRun, pending: boolean): string {
  if (pending || run.controls?.resume) return "pending";
  return ["failed", "interrupted"].includes(run.status ?? "") ? "error" : "recorded";
}
function renderEvidence(run: OperatorRun): void {
  const target = document.getElementById("task-evidence");
  if (!target) return;
  const pending = run.checkpoints?.find((item) => item.status === "pending");
  const [title, copy] = evidenceCopy(run, pending);
  const status = element(
    "p",
    pending ? "waiting for decision" : humanize(run.status ?? "Unknown"),
    "record-status",
  );
  status.dataset.tone = evidenceTone(run, Boolean(pending));
  target.replaceChildren(
    element("h3", title),
    status,
    element("p", copy),
    evidenceTable(run),
    element("p", "Recorded evidence is not a pass verdict.", "note"),
  );
  target.append(
    reference(`.pipeline/runs/${run.id}/`, "Copy reference"),
    element("p", "References only. Open artifact contents locally.", "note"),
  );
  if (!pending) target.append(checkpointRecord(run));
  const label = document.getElementById("task-evidence-label");
  if (label) label.textContent = taskCompleted(run) ? "Result" : "Evidence";
}
function handoffItem(title: string, content: Node[]): HTMLElement {
  const item = element("li");
  item.append(element("h3", title), ...content);
  return item;
}
function renderHandoff(run: OperatorRun): void {
  const target = document.getElementById("completion-handoff");
  if (!target) return;
  target.hidden = !taskCompleted(run);
  if (target.hidden) return;
  const list = element("ol", "", "handoff-list");
  list.append(
    handoffItem("Locate the workspace", [
      run.branch
        ? reference(run.branch, "Copy branch")
        : element("p", "Branch reference not recorded."),
      element("p", run.workspace_label ?? "Workspace label unavailable."),
    ]),
  );
  list.append(
    handoffItem("Inspect the local report", [
      reference(`.pipeline/runs/${run.id}/run-report.md`, "Copy report reference"),
      element("p", "Reference is relative to the run worktree. Inspect report contents locally."),
    ]),
  );
  list.append(
    handoffItem("Review the worktree diff", [
      element("p", "Use your editor and Git to review the actual changes."),
      element("p", "Completion applies to this workflow run. Human release review remains."),
    ]),
  );
  const back = element("button", "Return to all runs", "btn btn--wide return-runs");
  back.type = "button";
  back.dataset.allRuns = "";
  target.replaceChildren(list, back);
}
let lastTaskView = "";

export function renderTaskView(run: OperatorRun): void {
  const signature = JSON.stringify([
    run.id,
    run.project_id,
    run.status,
    run.runtime_active,
    run.controls,
    run.workflow,
    run.gates,
    run.checkpoints,
    run.branch,
    run.workspace_mode,
    run.workspace_label,
  ]);
  if (signature === lastTaskView) return;
  lastTaskView = signature;
  journey(run);
  renderEvidence(run);
  renderHandoff(run);
  const workflow = record(run.workflow);
  const identity = [
    text(workflow.workflow_id, "Workflow not recorded"),
    workflow.revision === undefined ? null : `revision ${text(workflow.revision)}`,
    humanize(run.workspace_mode ?? "workspace unavailable"),
  ]
    .filter(Boolean)
    .join(" · ");
  const workflowLine = document.getElementById("run-workflow");
  if (workflowLine) workflowLine.textContent = identity;
  const heading = document.getElementById("checkpoint-heading");
  if (heading) heading.textContent = taskCompleted(run) ? "Continue locally" : "Decision";
  const footer = document.getElementById("task-footer-status");
  if (footer)
    footer.textContent = `${run.project_id ?? "Local project"} / ${taskCompleted(run) ? "human release review remains" : humanize(run.status ?? "unknown")}`;
}

/** Displays the actual recorded outcome and rationale after the decision form closes. */
export function renderSavedDecision(run: OperatorRun | null): void {
  const target = document.getElementById("saved-decision");
  if (!target) return;
  const checkpoint = run?.checkpoints?.filter((item) => item.status !== "pending").at(-1);
  target.hidden = !checkpoint;
  if (!checkpoint) return;
  const decision = record(checkpoint.decision);
  const fields = [
    ["Outcome", humanize(checkpoint.status)],
    ["Actor", text(decision.actor)],
    ["Rationale", text(decision.rationale)],
  ];
  target.replaceChildren(
    ...fields.map(([label, value]) => {
      const row = element("div");
      row.append(element("dt", label), element("dd", value));
      return row;
    }),
  );
  const heading = document.querySelector("#checkpoint-empty h3");
  if (heading) heading.textContent = "Saved decision";
  const copy = document.getElementById("checkpoint-empty-copy");
  if (copy)
    copy.textContent =
      checkpoint.status === "approved"
        ? "Approval is recorded. Resume remains a separate action."
        : "This checkpoint decision is terminal; the operator cannot resume it.";
}
export function renderRecentEvents(events: OperatorEvent[], error: string | null): void {
  const target = document.getElementById("recent-events");
  if (!target) return;
  if (error || !events.length) {
    target.replaceChildren(
      element("p", error ? `Evidence unavailable: ${error}` : "No projected events yet.", "note"),
    );
    return;
  }
  target.replaceChildren(
    ...events.slice(-3).map((event) => {
      const row = element("div", "", "recent-event");
      const time = element("time", formatTime(event.ts));
      if (event.ts) time.dateTime = event.ts;
      row.append(
        time,
        element("span", event.phase ?? humanize(event.event)),
        element("span", humanize(event.status ?? event.event ?? "unknown")),
      );
      return row;
    }),
  );
}
