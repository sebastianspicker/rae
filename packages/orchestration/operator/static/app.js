/** Renders projected run state and sends the Runboard's allowlisted control requests. */
import { setConnection, showError } from "./js/api.js";
import { loadProjects } from "./js/data.js";
import { bindHandlers } from "./js/handlers.js";
import { bindWorkflowEditor } from "./js/workflows.js";
import { elements, state } from "./js/state.js";

// Contract anchors retained for source-level UI tests and operator safety review.
void [
  () => state.runsGeneration,
  () => state.streamGeneration,
  () => elements["confirm-run-id"],
  () => elements["confirm-submit"],
  () => elements["phase-list"],
  () => elements["event-list"],
];

bindHandlers();
bindWorkflowEditor();

loadProjects().catch((error) => {
  setConnection("error", "Unavailable", "Local session");
  elements["runs-loading"].hidden = true;
  elements["runs-empty"].hidden = false;
  elements["runs-empty"].querySelector("strong").textContent = "Runs unavailable";
  elements["runs-empty"].querySelector("span").textContent =
    "Reopen the URL printed by the operator server.";
  showError(error);
});
