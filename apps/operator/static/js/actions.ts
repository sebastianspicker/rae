/** Allowlisted run control and confirmation actions. */

import { api, showError, showToast } from "./api.js";
import { currentRun, elements, state } from "./state.js";
import { loadRuns } from "./data.js";
import { renderRun } from "./render.js";

export async function postAction(
  action: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  const run = currentRun();
  if (!run || state.actionPending) return;
  if (state.detailLoading || state.detailError || state.eventError)
    throw new Error("Refresh the run evidence before submitting a decision or control action.");
  const projectId = state.projectId;
  state.actionPending = true;
  renderRun();
  try {
    await api(
      `/projects/${encodeURIComponent(projectId ?? "")}/runs/${encodeURIComponent(run.id)}/${action}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (state.projectId === projectId) await loadRuns();
  } finally {
    state.actionPending = false;
    renderRun();
  }
}

export function openConfirmation(action: string): void {
  const run = currentRun();
  if (!run) return;
  const cleanup = action === "cleanup";
  state.confirmAction = action;
  elements["confirm-kicker"].textContent = cleanup ? "Worktree cleanup" : "Process interruption";
  elements["confirm-heading"].textContent = cleanup ? "Confirm cleanup" : "Confirm interrupt";
  elements["confirm-message"].textContent = cleanup
    ? "Cleanup preserves any dirty or unmerged worktree and remains subject to the pipeline ownership checks."
    : "Interrupt signals the owned process group. Inspect provider activity before reusing an interrupted run.";
  elements["confirm-expected-id"].textContent = run.id;
  elements["confirm-run-id"].value = "";
  elements["confirm-submit"].textContent = cleanup ? "Cleanup run" : "Interrupt run";
  elements["confirm-submit"].disabled = true;
  elements["confirm-dialog"].showModal();
  elements["confirm-run-id"].focus();
}

export function closeConfirmation(): void {
  state.confirmAction = null;
  elements["confirm-dialog"].close();
}

export async function submitConfirmation(): Promise<void> {
  const run = currentRun();
  const action = state.confirmAction;
  if (!run || !action || elements["confirm-run-id"].value !== run.id) return;
  elements["confirm-submit"].disabled = true;
  try {
    await postAction(action, { confirm_run_id: elements["confirm-run-id"].value });
    elements["confirm-dialog"].close();
    state.confirmAction = null;
    showToast(action === "cleanup" ? "Cleanup accepted." : "Interrupt accepted.", "notice");
  } catch (error) {
    showError(error);
  } finally {
    elements["confirm-submit"].disabled = false;
  }
}
