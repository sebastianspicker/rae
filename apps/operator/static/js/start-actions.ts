/** Validates the bounded start form and separates accepted requests from discovered runs. */
import { api, showToast } from "./api.js";
import { waitForNewRun } from "./data.js";
import { elements, state } from "./state.js";
import { validateTask } from "./task-input.js";
import { renderRun } from "./render.js";

function startError(message: string | null): void {
  const error = document.getElementById("start-error");
  if (error) {
    error.textContent = message ?? "";
    error.hidden = !message;
  }
  elements["start-task"].setAttribute("aria-invalid", String(Boolean(message)));
}

export async function submitStart(event: Event): Promise<void> {
  event.preventDefault();
  if (state.actionPending || !state.projectId) return;
  if (!elements["start-form"].reportValidity()) return;
  const validation = validateTask(elements["start-task"].value);
  startError(validation);
  if (validation) {
    elements["start-task"].focus();
    return;
  }
  const projectId = state.projectId;
  const previousIds = new Set(state.runs.map((run) => run.id));
  state.actionPending = true;
  elements["start-submit"].disabled = true;
  elements["new-run-button"].disabled = true;
  try {
    const result = await api<{ run_id?: string }>(
      `/projects/${encodeURIComponent(projectId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          task: elements["start-task"].value,
          checkpoint_policy: elements["start-checkpoint-policy"].value,
          ...(elements["start-execution-profile"].value
            ? { execution_profile_id: elements["start-execution-profile"].value }
            : {}),
        }),
      },
    );
    elements["start-task"].value = "";
    elements["start-dialog"].close();
    showToast("Run accepted. Waiting for its isolated worktree and run identifier…", "notice");
    await waitForNewRun(previousIds, projectId, result.run_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start run.";
    startError(message);
    showToast(message);
  } finally {
    state.actionPending = false;
    elements["start-submit"].disabled = false;
    elements["new-run-button"].disabled = !state.projectId;
    renderRun();
  }
}

export function bindStartForm(): void {
  elements["start-form"].addEventListener("submit", (event) => void submitStart(event));
  elements["start-task"].addEventListener("input", () => startError(null));
}
