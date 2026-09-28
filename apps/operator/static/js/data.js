/** Project, run, and event loading with stale-selection guards. */

import { api, eventStream, setConnection, showError } from "./api.js";
import { elements, state } from "./state.js";
import { renderEvents, renderRun, renderRuns } from "./render.js";
import { loadWorkflows } from "./workflows.js";

export async function loadProjects() {
  const data = await api("/projects");
  state.projects = data.projects;
  elements["project-select"].replaceChildren(
    ...state.projects.map((project) => new Option(project.label, project.id)),
  );
  state.projectId = state.projects[0]?.id ?? null;
  elements["new-run-button"].disabled = !state.projectId;
  setConnection(
    "connected",
    document.documentElement.dataset.demo === "true" ? "Mock-only demo" : "Local session",
    document.documentElement.dataset.demo === "true"
      ? "No repository access or publish controls"
      : "No publish controls",
  );
  if (state.projectId) {
    await loadExecutionProfiles();
    await loadRuns();
    await loadWorkflows();
  } else {
    elements["runs-loading"].hidden = true;
    renderRuns();
  }
}

export async function loadExecutionProfiles() {
  if (!state.projectId) return;
  const payload = await api(`/projects/${encodeURIComponent(state.projectId)}/execution-profiles`);
  state.workflowProfiles = payload.profiles ?? [];
  elements["start-execution-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) =>
        new Option(
          `${profile.id} · ${profile.readiness} · ${Object.entries(profile.models ?? {})
            .map(([tier, model]) => `${tier}: ${model}`)
            .join(", ")}`,
          profile.id,
        ),
    ),
  );
  elements["workflow-proposal-profile"].replaceChildren(
    new Option("Runtime default", ""),
    ...state.workflowProfiles.map(
      (profile) => new Option(`${profile.id} · ${profile.readiness}`, profile.id),
    ),
  );
}

export async function loadRuns(preserveSelection = true) {
  const generation = ++state.runsGeneration;
  const projectId = state.projectId;
  if (!projectId) return;
  elements["runs-loading"].hidden = false;
  elements["runs-empty"].hidden = true;
  const data = await api(`/projects/${encodeURIComponent(projectId)}/runs?limit=100&view=summary`);
  if (!isCurrentRunList(generation, projectId)) return;
  state.runs = data.runs;
  if (!preserveSelection || !state.runs.some((run) => run.id === state.runId)) {
    state.runId = state.runs[0]?.id ?? null;
  }
  await selectRun(state.runId);
}

export function isCurrentRunList(generation, projectId) {
  return generation === state.runsGeneration && projectId === state.projectId;
}

export async function selectRun(runId) {
  state.runId = runId;
  state.runDetail = null;
  state.detailError = null;
  state.detailLoading = Boolean(runId);
  const generation = ++state.detailGeneration;
  const projectId = state.projectId;
  renderRuns();
  renderRun();
  await Promise.all([loadEvents(), loadRunDetail(generation, projectId, runId)]);
}

async function loadRunDetail(generation, projectId, runId) {
  if (!projectId || !runId) return;
  try {
    const data = await api(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    );
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    state.runDetail = data.run;
  } catch (error) {
    if (
      generation !== state.detailGeneration ||
      projectId !== state.projectId ||
      runId !== state.runId
    )
      return;
    state.detailError = error.message;
    showError(error);
  } finally {
    if (
      generation === state.detailGeneration &&
      projectId === state.projectId &&
      runId === state.runId
    ) {
      state.detailLoading = false;
      renderRun();
    }
  }
}

export async function loadEvents() {
  state.streamAbort?.abort();
  const generation = ++state.streamGeneration;
  const projectId = state.projectId;
  const runId = state.runId;
  state.events = [];
  state.eventIds = new Set();
  state.eventAfter = 0;
  if (state.eventFrame !== null) cancelAnimationFrame(state.eventFrame);
  state.eventFrame = null;
  state.eventError = null;
  elements["stream-status"].textContent = "";
  renderEvents();
  if (!projectId || !runId) return;
  const pageController = new AbortController();
  state.streamAbort = pageController;
  let page;
  try {
    page = await loadEventPage(projectId, runId, pageController);
  } catch (error) {
    if (!isCurrentEventSelection(generation, projectId, runId)) return;
    state.eventError = error.message;
    elements["stream-status"].textContent = "Stream unavailable";
    renderEvents();
    showError(error);
    return;
  }
  if (!page) return;
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  state.events = page.events;
  state.eventIds = new Set(page.events.map((event) => event.seq));
  state.eventAfter = page.next_after;
  renderEvents();
  streamEvents(page.next_after, generation, projectId, runId).catch((error) => {
    if (error.name !== "AbortError" && isCurrentEventSelection(generation, projectId, runId)) {
      elements["stream-status"].textContent = "Stream unavailable";
      showError(error);
    }
  });
}

async function loadEventPage(projectId, runId, controller) {
  try {
    return await api(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?limit=200`,
      { signal: controller.signal },
    );
  } catch (error) {
    if (error.name === "AbortError") return null;
    throw error;
  }
}

export function isCurrentEventSelection(generation, projectId, runId) {
  return (
    generation === state.streamGeneration && projectId === state.projectId && runId === state.runId
  );
}

async function streamEvents(after, generation, projectId, runId) {
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  const controller = new AbortController();
  state.streamAbort = controller;
  elements["stream-status"].innerHTML =
    `<span class="spinner" aria-hidden="true"></span> Live verification`;
  const response = await openEventStream(after, controller, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) {
    controller.abort();
    return;
  }
  if (!response.ok) throw new Error(`Event stream unavailable (${response.status})`);
  await consumeEventStream(response, generation, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  // Refresh only the selected durable state; historical runs and event rows stay in place.
  await loadRunDetail(state.detailGeneration, projectId, runId);
  if (!isCurrentEventSelection(generation, projectId, runId)) return;
  elements["stream-status"].textContent = "Stream paused · reconnecting";
  scheduleEventRefresh(controller, generation, projectId, runId);
}

async function openEventStream(after, controller, projectId, runId) {
  return eventStream(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`,
    { signal: controller.signal },
  );
}

async function consumeEventStream(response, generation, projectId, runId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (!isCurrentEventSelection(generation, projectId, runId)) {
      await reader.cancel();
      break;
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) appendStreamEvents([buffer]);
      scheduleEventRender(generation, projectId, runId);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    appendStreamEvents(lines);
    scheduleEventRender(generation, projectId, runId);
  }
}

function scheduleEventRefresh(controller, generation, projectId, runId) {
  if (!controller.signal.aborted && generation === state.streamGeneration) {
    setTimeout(() => {
      if (isCurrentEventSelection(generation, projectId, runId)) {
        streamEvents(state.eventAfter, generation, projectId, runId).catch((error) => {
          if (error.name !== "AbortError" && isCurrentEventSelection(generation, projectId, runId))
            showError(error);
        });
      }
    }, 750);
  }
}

function appendStreamEvents(lines) {
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.event === "stream_error") throw new Error("Event stream unavailable");
    if (event.seq && !state.eventIds.has(event.seq)) {
      state.eventIds.add(event.seq);
      state.events.push(event);
      state.eventAfter = Math.max(state.eventAfter, event.seq);
    }
  }
}

function scheduleEventRender(generation, projectId, runId) {
  if (state.eventFrame !== null) return;
  state.eventFrame = requestAnimationFrame(() => {
    state.eventFrame = null;
    if (isCurrentEventSelection(generation, projectId, runId)) renderEvents();
  });
}

export async function waitForNewRun(previousIds) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await api(
      `/projects/${encodeURIComponent(state.projectId)}/runs?limit=100&view=summary`,
    );
    const discovered = data.runs.find((run) => !previousIds.has(run.id));
    if (discovered) {
      state.runs = data.runs;
      await selectRun(discovered.id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await loadRuns();
}
