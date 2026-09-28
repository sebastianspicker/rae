/** Keeps the run catalogue and local reference actions accessible beside a selected task. */
import { showToast } from "./api.js";
import { elements, state } from "./state.js";

export function showRunCatalogue(): void {
  document.body.dataset.runView = "list";
  const heading = document.getElementById("runs-heading");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
  heading?.scrollIntoView({ block: "start" });
}

export function showSelectedRun(): void {
  document.body.dataset.runView = "selected";
}

export function focusSelectedTask(): void {
  const heading = document.getElementById("run-task");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus();
}

async function copyReference(button: HTMLButtonElement): Promise<void> {
  const text = button.dataset.copyReference;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Reference copied.", "notice");
  } catch {
    showToast("Clipboard unavailable. Select and copy the displayed reference.", "notice");
  }
}

export function openStartDialog(): void {
  if (!state.projectId || state.actionPending) return;
  elements["start-dialog"].showModal();
  elements["start-task"].focus();
}

export function bindTaskNavigation(): void {
  document.getElementById("all-runs-button")?.addEventListener("click", showRunCatalogue);
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const copy = event.target.closest<HTMLButtonElement>("[data-copy-reference]");
    if (copy && !copy.disabled) void copyReference(copy);
    if (event.target.closest("[data-all-runs]")) showRunCatalogue();
    if (event.target.closest("[data-new-run]")) openStartDialog();
  });
}
