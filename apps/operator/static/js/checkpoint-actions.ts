/** Records attributable checkpoint decisions without treating approval as execution. */
import { postAction } from "./actions.js";
import { showError, showToast } from "./api.js";
import { humanize } from "./format.js";
import { elements, state } from "./state.js";

let lastDecision: { key: string; id: string } | null = null;

async function decide(button: HTMLButtonElement): Promise<void> {
  if (state.actionPending) return;
  const checkpointId = elements["checkpoint-content"].dataset.checkpointId;
  const rationale = elements["checkpoint-rationale"].value.trim();
  if (!rationale) {
    elements["decision-error"].textContent =
      "Add a rationale before recording this checkpoint decision.";
    elements["decision-error"].hidden = false;
    elements["checkpoint-rationale"].setAttribute("aria-invalid", "true");
    elements["checkpoint-rationale"].focus();
    return;
  }
  const key = JSON.stringify([
    state.projectId,
    state.runId,
    checkpointId,
    button.dataset.decision,
    rationale,
  ]);
  if (lastDecision?.key !== key) lastDecision = { key, id: crypto.randomUUID() };
  try {
    await postAction("checkpoint-decision", {
      checkpoint_id: checkpointId,
      decision: button.dataset.decision,
      decision_id: lastDecision.id,
      rationale,
    });
    showToast(`${humanize(button.dataset.decision ?? "decision")} decision recorded.`, "notice");
    if (!elements["resume-button"].disabled) elements["resume-button"].focus();
    else {
      elements["checkpoint-empty"].setAttribute("tabindex", "-1");
      elements["checkpoint-empty"].focus();
    }
  } catch (error) {
    showError(error);
  }
}

export function bindCheckpointActions(): void {
  elements["checkpoint-rationale"].addEventListener("input", () => {
    elements["rationale-count"].textContent =
      `${elements["checkpoint-rationale"].value.length} / 4096`;
    elements["decision-error"].hidden = true;
    elements["checkpoint-rationale"].removeAttribute("aria-invalid");
  });
  elements["decision-form"].addEventListener("submit", (event) => event.preventDefault());
  document.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => {
    button.addEventListener("click", () => void decide(button));
  });
}
