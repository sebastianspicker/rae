/** DOM renderers for runs, docket ledger, checkpoint, and evidence. */

import { elements, state, currentRun } from "./state.js";
import {
  escapeHtml,
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

export function visibleRuns() {
  const query = state.runQuery.trim().toLowerCase();
  return state.runs.filter((run) => {
    const matchesFilter = state.runFilter === "all" || runTone(run) === state.runFilter;
    const searchable =
      `${run.task} ${run.id} ${run.branch} ${run.status} ${phaseLabel(run.current_phase)}`.toLowerCase();
    return matchesFilter && (!query || searchable.includes(query));
  });
}

export function renderRuns() {
  elements["runs-loading"].hidden = true;
  const visible = visibleRuns();
  elements["runs-empty"].hidden = visible.length !== 0;
  if (!visible.length) {
    const heading = elements["runs-empty"].querySelector("strong");
    const copy = elements["runs-empty"].querySelector("span");
    if (state.runs.length) {
      heading.textContent = "No matching runs";
      copy.textContent = "Clear the search or change the state filter.";
    } else {
      heading.textContent = "No runs yet";
      copy.textContent = "Start a bounded run for this project.";
    }
  }
  elements["runs-list"].replaceChildren(
    ...visible.map((run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-row";
      button.dataset.runId = run.id;
      button.dataset.tone = runTone(run);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(run.id === state.runId));
      const stateWord = runStateWord(run);
      button.innerHTML = `
        <span class="run-row__top">
          <span class="run-row__id mono">${escapeHtml(shortId(run.id))}</span>
          <span class="run-row__state state-${escapeHtml(stateWord)}">${escapeHtml(stateWord)}</span>
        </span>
        <span class="run-row__task">${escapeHtml(run.task || run.id)}</span>
        <span class="run-row__meta">
          <span>${escapeHtml(phaseLabel(run.current_phase))}</span>
          <span class="mono">${escapeHtml(relativeTime(run.updated_at || run.started_at))}</span>
        </span>
      `;
      return button;
    }),
  );
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
  if (gate?.artifact_ref) return shortRef(gate.artifact_ref);
  return "—";
}

function claimCell(rowState, hasPendingCheckpoint) {
  if (rowState === "wait") return "—";
  if (rowState === "live" && hasPendingCheckpoint) return "unbound";
  return "local";
}

export function renderRunPhases(run) {
  const phases = run.phase_order ?? [];
  const activeIndex = phases.indexOf(run.current_phase);
  const pending = run.checkpoints?.find((item) => item.status === "pending") ?? null;
  elements["phase-list"].innerHTML = phases
    .map((phase, index) => {
      const complete =
        run.completed_gates.includes(`${phase}-gate`) || (activeIndex >= 0 && index < activeIndex);
      const isLive = index === activeIndex || (pending && pending.phase === phase);
      const rowState = complete && !isLive ? "done" : isLive ? "live" : "wait";
      const gate = run.gates?.find((item) => item.phase === phase || String(item.gate_id || "").startsWith(phase));
      const gateInfo =
        rowState === "wait"
          ? { word: "—", cls: "g-wait" }
          : isLive && pending
            ? { word: "hold", cls: "g-hold" }
            : gateWord(gate?.status ?? (complete ? "pass" : "pending"));
      const claim = claimCell(rowState, Boolean(pending && isLive));
      const selected = isLive ? " is-selected" : "";
      return `
        <tr class="is-${rowState}${selected}" data-stage="${escapeHtml(phase)}" ${isLive ? 'aria-current="step"' : ""}>
          <td class="mono">${String(index + 1).padStart(2, "0")}</td>
          <td>${escapeHtml(phase)}</td>
          <td class="mono">${escapeHtml(artifactCell(run, phase))}</td>
          <td><span class="g ${gateInfo.cls}">${escapeHtml(gateInfo.word)}</span></td>
          <td class="claim${claim === "unbound" ? " is-open" : ""}">${escapeHtml(claim)}</td>
        </tr>
      `;
    })
    .join("");
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
    checkpoint.purpose === "ship" ? "Release checkpoint" : "Continue into quality stages?";
  if (checkpoint.purpose !== "ship") {
    elements["checkpoint-title"].textContent = `${phaseLabel(checkpoint.phase)} may continue?`;
  }
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

export function renderEvents() {
  if (state.eventError) {
    elements["event-count"].textContent = "Unavailable";
    elements["event-list"].innerHTML = `
      <tr>
        <td>Unavailable</td>
        <td><span class="category">Runtime</span></td>
        <td><span class="evidence-title">Evidence unavailable</span></td>
        <td>${escapeHtml(state.eventError)}</td>
        <td><span class="result" data-tone="error">${icon("reject")}Error</span></td>
      </tr>
    `;
    return;
  }
  elements["event-count"].textContent =
    `${state.events.length} projected ${state.events.length === 1 ? "event" : "events"}`;
  elements["event-list"].innerHTML = state.events.length
    ? state.events
        .map((event, index) => {
          const status = event.status ?? event.event;
          const statusTone = tone(status);
          const reference =
            event.artifact_ref ?? event.gate_id ?? event.event_id ?? `Sequence ${event.seq}`;
          const details = [
            `Sequence ${event.seq ?? "unavailable"}`,
            event.tier ? `Tier ${event.tier}` : null,
            event.gate_id ? `Gate ${event.gate_id}` : null,
            `Projected status ${status}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return `
            <tr>
              <td>
                <button
                  class="evidence-toggle"
                  type="button"
                  aria-expanded="false"
                  aria-controls="event-extra-${index}"
                  aria-label="Show details for ${escapeHtml(humanize(event.event))}"
                >${icon("arrow")}</button>${escapeHtml(formatTime(event.ts))}
              </td>
              <td><span class="category">${escapeHtml(phaseLabel(event.phase))}</span></td>
              <td><span class="evidence-title">${escapeHtml(humanize(event.event))}</span></td>
              <td><span class="evidence-reference">${escapeHtml(reference)}</span></td>
              <td><span class="result" data-tone="${statusTone}">${icon(statusTone === "error" ? "reject" : "check")}${escapeHtml(humanize(status))}</span></td>
            </tr>
            <tr class="evidence-extra" id="event-extra-${index}" hidden>
              <td colspan="5">${escapeHtml(details)}</td>
            </tr>
          `;
        })
        .join("")
    : `
      <tr>
        <td>Not available</td>
        <td><span class="category">Run</span></td>
        <td><span class="evidence-title">No projected events yet</span></td>
        <td>The sanitized stream is empty for this run.</td>
        <td><span class="result" data-tone="muted">${icon("info")}Empty</span></td>
      </tr>
    `;
  for (const toggle of document.querySelectorAll(".evidence-toggle")) {
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      document.getElementById(toggle.getAttribute("aria-controls")).hidden = !expanded;
    });
  }
}

export function setEvidenceExpanded(expanded) {
  for (const toggle of document.querySelectorAll(".evidence-toggle")) {
    toggle.setAttribute("aria-expanded", String(expanded));
    document.getElementById(toggle.getAttribute("aria-controls")).hidden = !expanded;
  }
}
