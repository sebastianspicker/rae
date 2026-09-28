/** Wire DOM controls to operator actions. */

import { showError, showToast } from "./api.js";
import { closeConfirmation, openConfirmation, postAction, submitConfirmation } from "./actions.js";
import { loadExecutionProfiles, loadMoreRuns, loadRuns, selectRun } from "./data.js";
import { humanize } from "./format.js";
import { renderRuns, setEvidenceExpanded } from "./render.js";
import { loadWorkflows } from "./workflows.js";
import { elements, state } from "./state.js";

import {
  bindTaskNavigation,
  openStartDialog,
  showRunCatalogue,
  showSelectedRun,
  focusSelectedTask,
} from "./navigation.js";
import { bindStartForm } from "./start-actions.js";
import { bindCheckpointActions } from "./checkpoint-actions.js";

function bindProjects(): void {
  elements["runs-load-more"].addEventListener("click", () => void loadMoreRuns().catch(showError));
  elements["project-select"].addEventListener("change", async () => {
    state.projectId = elements["project-select"].value;
    state.runId = null;
    state.runQuery = "";
    elements["run-search-input"].value = "";
    await loadRuns(false).catch(showError);
    await loadExecutionProfiles().catch(showError);
    await loadWorkflows().catch(showError);
  });
}

function bindRunSearch(): void {
  elements["toggle-search"].addEventListener("click", () => {
    const expanded = elements["toggle-search"].getAttribute("aria-expanded") !== "true";
    elements["toggle-search"].setAttribute("aria-expanded", String(expanded));
    elements["run-search"].hidden = !expanded;
    if (expanded) {
      showRunCatalogue();
      elements["run-search-input"].focus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    elements["toggle-search"].click();
  });

  elements["run-search-input"].addEventListener("input", () => {
    state.runQuery = elements["run-search-input"].value;
    renderRuns();
  });

  elements["cycle-filter"].addEventListener("click", () => {
    const filters = ["all", "active", "proof", "blocked"];
    state.runFilter = filters[(filters.indexOf(state.runFilter) + 1) % filters.length] ?? "all";
    const label = state.runFilter === "proof" ? "Completed" : humanize(state.runFilter);
    elements["filter-label"].textContent = label;
    elements["cycle-filter"].dataset.active = String(state.runFilter !== "all");
    elements["cycle-filter"].setAttribute("aria-label", `Filter runs: ${label.toLowerCase()}`);
    renderRuns();
  });
}

function bindRunSelection(): void {
  elements["runs-list"].addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
    const options = [...elements["runs-list"].querySelectorAll(".run-row")];
    const index = document.activeElement ? options.indexOf(document.activeElement) : -1;
    const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
    const target = options[(Math.max(index, 0) + direction + options.length) % options.length] as
      | HTMLElement
      | undefined;
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });

  // selectRun is used by run-row click handlers; keep reference live for list re-renders
  elements["runs-list"].addEventListener("click", (event) => {
    const row =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".run-row") : null;
    if (!row?.dataset.runId) return;
    showSelectedRun();
    selectRun(row.dataset.runId).then(focusSelectedTask).catch(showError);
  });
}

function bindRunActions(): void {
  elements["new-run-button"].addEventListener("click", openStartDialog);

  for (const id of ["start-close", "start-cancel"]) {
    elements[id].addEventListener("click", () => elements["start-dialog"].close());
  }

  elements["stop-button"].addEventListener("click", async () => {
    try {
      await postAction("stop");
      showToast("Stop requested at the next safe boundary.", "notice");
    } catch (error) {
      showError(error);
    }
  });

  elements["resume-button"].addEventListener("click", async () => {
    try {
      await postAction("resume");
      showToast("Resume accepted.", "notice");
    } catch (error) {
      showError(error);
    }
  });

  elements["interrupt-button"].addEventListener("click", () => openConfirmation("interrupt"));
  elements["cleanup-button"].addEventListener("click", () => openConfirmation("cleanup"));
}

function bindConfirmations(): void {
  elements["confirm-run-id"].addEventListener("input", () => {
    elements["confirm-submit"].disabled =
      elements["confirm-run-id"].value !== elements["confirm-expected-id"].textContent;
  });

  for (const id of ["confirm-close", "confirm-cancel"]) {
    elements[id].addEventListener("click", closeConfirmation);
  }

  elements["confirm-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitConfirmation();
  });
}

function bindEvidenceControls(): void {
  elements["expand-all"].addEventListener("click", () => setEvidenceExpanded(true));
  elements["collapse-all"].addEventListener("click", () => setEvidenceExpanded(false));
  elements["review-jump"].addEventListener("click", () => {
    elements["decision-panel"].scrollIntoView({ behavior: "instant", block: "start" });
    elements["checkpoint-rationale"].focus({ preventScroll: true });
  });
}

export function bindHandlers(): void {
  bindTaskNavigation();
  bindStartForm();
  bindCheckpointActions();
  bindProjects();
  bindRunSearch();
  bindRunSelection();
  bindRunActions();
  bindConfirmations();
  bindEvidenceControls();
}
