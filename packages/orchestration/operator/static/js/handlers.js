/** Wire DOM controls to operator actions. */

import { api, showError, showToast } from "./api.js";
import { closeConfirmation, openConfirmation, postAction, submitConfirmation } from "./actions.js";
import { loadRuns, selectRun, waitForNewRun } from "./data.js";
import { humanize } from "./format.js";
import { renderRuns, setEvidenceExpanded } from "./render.js";
import { loadWorkflows } from "./workflows.js";
import { currentRun, elements, state } from "./state.js";

export function bindHandlers() {
  elements["project-select"].addEventListener("change", async (event) => {
    state.projectId = event.target.value;
    state.runId = null;
    state.runQuery = "";
    elements["run-search-input"].value = "";
    await loadRuns(false).catch(showError);
    await loadWorkflows().catch(showError);
  });

  elements["toggle-search"].addEventListener("click", () => {
    const expanded = elements["toggle-search"].getAttribute("aria-expanded") !== "true";
    elements["toggle-search"].setAttribute("aria-expanded", String(expanded));
    elements["run-search"].hidden = !expanded;
    if (expanded) elements["run-search-input"].focus();
  });

  elements["run-search-input"].addEventListener("input", (event) => {
    state.runQuery = event.target.value;
    renderRuns();
  });

  elements["cycle-filter"].addEventListener("click", () => {
    const filters = ["all", "active", "proof", "blocked"];
    state.runFilter = filters[(filters.indexOf(state.runFilter) + 1) % filters.length];
    const label = state.runFilter === "proof" ? "Completed" : humanize(state.runFilter);
    elements["filter-label"].textContent = label;
    elements["cycle-filter"].dataset.active = String(state.runFilter !== "all");
    elements["cycle-filter"].setAttribute("aria-label", `Filter runs: ${label.toLowerCase()}`);
    renderRuns();
  });

  elements["runs-list"].addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
    const options = [...elements["runs-list"].querySelectorAll(".run-row")];
    const index = options.indexOf(document.activeElement);
    const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
    const target = options[(Math.max(index, 0) + direction + options.length) % options.length];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });

  // selectRun is used by run-row click handlers; keep reference live for list re-renders
  elements["runs-list"].addEventListener("click", (event) => {
    const row = event.target.closest(".run-row");
    if (!row?.dataset.runId) return;
    selectRun(row.dataset.runId).catch(showError);
  });

  elements["new-run-button"].addEventListener("click", () => {
    elements["start-task"].value = "";
    elements["start-dialog"].showModal();
    elements["start-task"].focus();
  });

  for (const element of [elements["start-close"], elements["start-cancel"]]) {
    element.addEventListener("click", () => elements["start-dialog"].close());
  }

  elements["start-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!elements["start-form"].reportValidity()) return;
    const previousIds = new Set(state.runs.map((run) => run.id));
    elements["start-submit"].disabled = true;
    try {
      await api(`/projects/${encodeURIComponent(state.projectId)}/runs`, {
        method: "POST",
        body: JSON.stringify({
          task: elements["start-task"].value,
          checkpoint_policy: elements["start-checkpoint-policy"].value,
        }),
      });
      elements["start-dialog"].close();
      showToast("Run accepted. Creating its isolated worktree…", "notice");
      await waitForNewRun(previousIds);
    } catch (error) {
      showError(error);
    } finally {
      elements["start-submit"].disabled = false;
    }
  });

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

  elements["confirm-run-id"].addEventListener("input", () => {
    elements["confirm-submit"].disabled =
      elements["confirm-run-id"].value !== elements["confirm-expected-id"].textContent;
  });

  for (const element of [elements["confirm-close"], elements["confirm-cancel"]]) {
    element.addEventListener("click", closeConfirmation);
  }

  elements["confirm-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitConfirmation();
  });

  elements["checkpoint-rationale"].addEventListener("input", () => {
    elements["rationale-count"].textContent =
      `${elements["checkpoint-rationale"].value.length} / 4096`;
    elements["decision-error"].hidden = true;
  });

  elements["decision-form"].addEventListener("submit", (event) => event.preventDefault());

  document.querySelectorAll("[data-decision]").forEach((button) => {
    button.addEventListener("click", async () => {
      const checkpointId = elements["checkpoint-content"].dataset.checkpointId;
      const rationale = elements["checkpoint-rationale"].value.trim();
      if (!rationale) {
        elements["decision-error"].textContent =
          "Add a rationale before recording this checkpoint decision.";
        elements["decision-error"].hidden = false;
        elements["checkpoint-rationale"].focus();
        return;
      }
      const decisionButtons = [...document.querySelectorAll("[data-decision]")];
      decisionButtons.forEach((item) => {
        item.disabled = true;
      });
      try {
        await postAction("checkpoint-decision", {
          checkpoint_id: checkpointId,
          decision: button.dataset.decision,
          decision_id: crypto.randomUUID(),
          rationale,
        });
        showToast(`${humanize(button.dataset.decision)} decision recorded.`, "notice");
      } catch (error) {
        showError(error);
      } finally {
        decisionButtons.forEach((item) => {
          item.disabled = false;
        });
      }
    });
  });

  elements["expand-all"].addEventListener("click", () => setEvidenceExpanded(true));
  elements["collapse-all"].addEventListener("click", () => setEvidenceExpanded(false));
  elements["review-jump"].addEventListener("click", () => {
    elements["decision-panel"].scrollIntoView({ behavior: "smooth", block: "start" });
    elements["checkpoint-rationale"].focus({ preventScroll: true });
  });

  // silence unused import warning for currentRun in some bundlers
  void currentRun;
}
