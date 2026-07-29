/** DOM renderers for runs, docket ledger, checkpoint, and evidence. */

import { currentRun, elements, state } from "./state.js";
import {
  formatCost,
  formatDateTime,
  formatNumber,
  formatTime,
  humanize,
  icon,
  phaseLabel,
  relativeTime,
  runStateWord,
  runTone,
  shortId,
  shortRef,
  tone,
} from "./format.js";

function node(tagName, { className, text, attrs = {}, dataset = {} } = {}, children = []) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  for (const [name, value] of Object.entries(dataset)) element.dataset[name] = value;
  element.append(...children);
  return element;
}

function tableCell(content, options) {
  return node("td", options, Array.isArray(content) ? content : [content]);
}

export function visibleRuns() {
  const query = state.runQuery.trim().toLowerCase();
  return state.runs.filter((run) => {
    const matchesFilter = state.runFilter === "all" || runTone(run) === state.runFilter;
    const searchable =
      `${run.task} ${run.id} ${run.branch} ${run.status} ${phaseLabel(run.current_phase)}`.toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });
}

function runRow(run) {
  const stateWord = runStateWord(run);
  const top = node("span", { className: "run-row__top" }, [
    node("span", { className: "run-row__id mono", text: shortId(run.id) }),
    node("span", { className: `run-row__state state-${stateWord}`, text: stateWord }),
  ]);
  const meta = node("span", { className: "run-row__meta" }, [
    node("span", { text: phaseLabel(run.current_phase) }),
    node("span", { className: "mono", text: relativeTime(run.updated_at || run.started_at) }),
  ]);
  return node(
    "button",
    {
      className: "run-row",
      attrs: { type: "button", role: "option", "aria-selected": String(run.id === state.runId) },
      dataset: { runId: run.id, tone: runTone(run) },
    },
    [top, node("span", { className: "run-row__task", text: run.task || run.id }), meta],
  );
}

export function renderRuns() {
  elements["runs-loading"].hidden = true;
  const visible = visibleRuns();
  elements["runs-empty"].hidden = visible.length !== 0;
  if (!visible.length) {
    const heading = elements["runs-empty"].querySelector("strong");
    const copy = elements["runs-empty"].querySelector("span");
    heading.textContent = state.runs.length ? "No matching runs" : "No runs yet";
    copy.textContent = state.runs.length
      ? "Clear the search or change the state filter."
      : "Start a bounded run for this project.";
  }
  elements["runs-list"].replaceChildren(...visible.map(runRow));
}

export function renderRunControls(run) {
  for (const [element, key] of [
    [elements["stop-button"], "stop"],
    [elements["interrupt-button"], "interrupt"],
    [elements["resume-button"], "resume"],
    [elements["cleanup-button"], "cleanup"],
  ]) {
    element.disabled = !run?.controls[key];
  }
}

function gateWord(status) {
  const value = tone(status);
  if (value === "pass") return { word: "pass", cls: "g-pass" };
  if (value === "error") return { word: "fail", cls: "g-hold" };
  if (value === "active") return { word: "hold", cls: "g-hold" };
  return { word: "—", cls: "g-wait" };
}

function artifactCell(run, phase) {
  const gate = run.gates?.find((item) => item.phase === phase || item.gate_id === `${phase}-gate`);
  return gate?.artifact_ref ? shortRef(gate.artifact_ref) : "—";
}

function claimCell(rowState, hasPendingCheckpoint) {
  if (rowState === "wait") return "—";
  return rowState === "live" && hasPendingCheckpoint ? "unbound" : "local";
}

function phaseRow(run, phase, index, activeIndex, pending) {
  const complete =
    run.completed_gates.includes(`${phase}-gate`) || (activeIndex >= 0 && index < activeIndex);
  const isLive = index === activeIndex || (pending && pending.phase === phase);
  const rowState = complete && !isLive ? "done" : isLive ? "live" : "wait";
  const gate = run.gates?.find(
    (item) => item.phase === phase || String(item.gate_id || "").startsWith(phase),
  );
  const gateInfo =
    rowState === "wait"
      ? { word: "—", cls: "g-wait" }
      : isLive && pending
        ? { word: "hold", cls: "g-hold" }
        : gateWord(gate?.status ?? (complete ? "pass" : "pending"));
  const claim = claimCell(rowState, Boolean(pending && isLive));
  return node(
    "tr",
    {
      className: `is-${rowState}${isLive ? " is-selected" : ""}`,
      attrs: isLive ? { "aria-current": "step" } : {},
      dataset: { stage: phase },
    },
    [
      tableCell(node("span", { className: "mono", text: String(index + 1).padStart(2, "0") })),
      tableCell(phase),
      tableCell(node("span", { className: "mono", text: artifactCell(run, phase) })),
      tableCell(node("span", { className: `g ${gateInfo.cls}`, text: gateInfo.word })),
      tableCell(claim, { className: `claim${claim === "unbound" ? " is-open" : ""}` }),
    ],
  );
}

export function renderRunPhases(run) {
  const phases = run.phase_order ?? [];
  const activeIndex = phases.indexOf(run.current_phase);
  const pending = run.checkpoints?.find((item) => item.status === "pending") ?? null;
  elements["phase-list"].replaceChildren(
    ...phases.map((phase, index) => phaseRow(run, phase, index, activeIndex, pending)),
  );
}

export function renderRunSummary(run) {
  const gatesPassed = run.gates.filter((gate) => tone(gate.status) === "pass").length;
  elements["gate-count"].textContent = `${gatesPassed} / ${run.gates.length}`;
  elements["artifact-count"].textContent = formatNumber(run.evidence.present);
  elements["agent-count"].textContent = formatNumber(run.resources.agent_calls);
  elements["input-count"].textContent = formatNumber(run.resources.input);
  elements["output-count"].textContent = formatNumber(run.resources.output, "Unavailable");
  elements["cost-count"].textContent = formatCost(run.resources.cost);
  elements["updated-value"].textContent = formatDateTime(run.updated_at);
  elements["run-id-value"].textContent = run.id;
}

export function renderRun() {
  const run = currentRun();
  elements["workspace-empty"].hidden = Boolean(run);
  elements["run-content"].hidden = !run;
  renderRunControls(run);
  renderCheckpoint(run);
  if (!run) {
    elements["context-run"].textContent = "Not selected";
    elements["context-workspace"].textContent = "Not selected";
    elements["context-started"].textContent = "Unavailable";
    return;
  }
  elements["run-title"].textContent = run.id;
  elements["run-branch"].textContent = run.branch || "Not recorded";
  const taskEl = document.getElementById("run-task");
  if (taskEl) taskEl.textContent = run.task || "No task recorded";
  elements["run-workspace"].textContent =
    run.workspace_mode === "guarded"
      ? `${run.workspace_label} · guarded phase`
      : `${run.workspace_label} · ${humanize(run.workspace_mode)}`;
  elements["run-terminal"].textContent = humanize(run.status);
  elements["run-terminal"].dataset.tone = tone(run.status);
  elements["context-run"].textContent = run.id;
  elements["context-workspace"].textContent = run.workspace_label || "Unavailable";
  elements["context-started"].textContent = formatDateTime(run.started_at);
  renderRunPhases(run);
  renderRunSummary(run);
}

export function renderCheckpoint(run) {
  const checkpoint = run?.checkpoints.find((item) => item.status === "pending") ?? null;
  elements["checkpoint-empty"].hidden = Boolean(checkpoint);
  elements["checkpoint-content"].hidden = !checkpoint;
  elements["review-jump"].hidden = !checkpoint;
  elements["decision-panel"].hidden = false;
  if (!checkpoint) {
    elements["checkpoint-empty-copy"].textContent = run
      ? `No decision is waiting for this ${humanize(run.status).toLowerCase()} run.`
      : "Select a run to inspect its decision state.";
    elements["next-step-copy"].textContent =
      "This console exposes no commit, push, publish, or deploy action.";
    return;
  }
  elements["checkpoint-title"].textContent =
    checkpoint.purpose === "ship"
      ? "Release checkpoint"
      : `${phaseLabel(checkpoint.phase)} may continue?`;
  elements["checkpoint-message"].textContent = checkpoint.message;
  elements["checkpoint-rationale"].value = "";
  elements["rationale-count"].textContent = "0 / 4096";
  elements["decision-error"].hidden = true;
  elements["checkpoint-meta"].textContent =
    `Human checkpoint · ${checkpoint.checkpoint_id} · open · ${formatDateTime(checkpoint.requested_at)}`;
  elements["checkpoint-content"].dataset.checkpointId = checkpoint.checkpoint_id;
  elements["next-step-copy"].textContent =
    "Does not commit, push, publish, deploy, replace policy, expose the custom provider, or force-clean a dirty worktree.";
}

function eventDetails(event, status) {
  return [
    `Sequence ${event.seq ?? "unavailable"}`,
    event.tier ? `Tier ${event.tier}` : null,
    event.gate_id ? `Gate ${event.gate_id}` : null,
    `Projected status ${status}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function eventRow(event, index) {
  const status = event.status ?? event.event;
  const statusTone = tone(status);
  const detailId = `event-extra-${index}`;
  const toggle = node("button", {
    className: "evidence-toggle",
    attrs: {
      type: "button",
      "aria-expanded": "false",
      "aria-controls": detailId,
      "aria-label": `Show details for ${humanize(event.event)}`,
    },
  });
  toggle.append(icon("arrow"));
  const detail = node("tr", { className: "evidence-extra", attrs: { id: detailId, hidden: "" } }, [
    tableCell(eventDetails(event, status), { attrs: { colspan: "5" } }),
  ]);
  toggle.addEventListener("click", () => setEventExpanded(toggle, detail, true));
  const reference =
    event.artifact_ref ?? event.gate_id ?? event.event_id ?? `Sequence ${event.seq}`;
  const result = node("span", { className: "result", dataset: { tone: statusTone } }, [
    icon(statusTone === "error" ? "reject" : "check"),
    document.createTextNode(humanize(status)),
  ]);
  const row = node("tr", {}, [
    tableCell([toggle, document.createTextNode(formatTime(event.ts))]),
    tableCell(node("span", { className: "category", text: phaseLabel(event.phase) })),
    tableCell(node("span", { className: "evidence-title", text: humanize(event.event) })),
    tableCell(node("span", { className: "evidence-reference", text: reference })),
    tableCell(result),
  ]);
  return [row, detail];
}

function eventMessageRow({ category, title, reference, toneValue, iconName, result }) {
  const resultNode = node("span", { className: "result", dataset: { tone: toneValue } }, [
    icon(iconName),
    document.createTextNode(result),
  ]);
  return node("tr", {}, [
    tableCell("Unavailable"),
    tableCell(node("span", { className: "category", text: category })),
    tableCell(node("span", { className: "evidence-title", text: title })),
    tableCell(reference),
    tableCell(resultNode),
  ]);
}

function setEventExpanded(toggle, detail, expanded) {
  toggle.setAttribute("aria-expanded", String(expanded));
  detail.hidden = !expanded;
}

export function renderEvents() {
  if (state.eventError) {
    elements["event-count"].textContent = "Unavailable";
    elements["event-list"].replaceChildren(
      eventMessageRow({
        category: "Runtime",
        title: "Evidence unavailable",
        reference: state.eventError,
        toneValue: "error",
        iconName: "reject",
        result: "Error",
      }),
    );
    return;
  }
  elements["event-count"].textContent =
    `${state.events.length} projected ${state.events.length === 1 ? "event" : "events"}`;
  const rows = state.events.length
    ? state.events.flatMap(eventRow)
    : [
        eventMessageRow({
          category: "Run",
          title: "No projected events yet",
          reference: "The sanitized stream is empty for this run.",
          toneValue: "muted",
          iconName: "info",
          result: "Empty",
        }),
      ];
  elements["event-list"].replaceChildren(...rows);
}

export function setEvidenceExpanded(expanded) {
  for (const toggle of document.querySelectorAll(".evidence-toggle")) {
    const detail = document.getElementById(toggle.getAttribute("aria-controls"));
    if (detail) setEventExpanded(toggle, detail, expanded);
  }
}
