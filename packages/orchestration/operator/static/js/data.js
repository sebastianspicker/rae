/** Project, run, and event loading with stale-selection guards. */

import { api, setConnection, showError } from "./api.js";
import { elements, state } from "./state.js";
import { renderEvents, renderRun, renderRuns } from "./render.js";

export async function loadProjects() {
  const data = await api("/projects");
  state.projects = data.projects;
  elements["project-select"].replaceChildren(
    ...state.projects.map((project) => new Option(project.label, project.id)),
  );
  state.projectId = state.projects[0]?.id ?? null;
  elements["new-run-button"].disabled = !state.projectId;
  setConnection("connected", "Local session", "No publish controls");
  if (state.projectId) {
    await loadRuns();
  } else {
    elements["runs-loading"].hidden = true;
    renderRuns();
  }
}

export async function loadRuns(preserveSelection = true) {
  const generation = ++state.runsGeneration;
  const projectId = state.projectId;
  if (!projectId) return;
  elements["runs-loading"].hidden = false;
  elements["runs-empty"].hidden = true;
  const data = await api(`/projects/${encodeURIComponent(projectId)}/runs?limit=100`);
  if (!isCurrentRunList(generation, projectId)) return;
  state.runs = data.runs;
  if (!preserveSelection || !state.runs.some((run) => run.id === state.runId)) {
    state.runId = state.runs[0]?.id ?? null;
  }
  renderRuns();
  renderRun();
  await loadEvents();
}

export function isCurrentRunList(generation, projectId) {
  return generation === state.runsGeneration && projectId === state.projectId;
}

export async function selectRun(runId) {
  state.runId = runId;
  renderRuns();
  renderRun();
  await loadEvents();
}

export async function loadEvents() {
  state.streamAbort?.abort();
  const generation = ++state.streamGeneration;
  const projectId = state.projectId;
  const runId = state.runId;
  state.events = [];
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
  renderEvents();
  streamEvents(page.next_after, generation, projectId, runId).catch((error) => {
    if (error.name !== "AbortError") {
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
  elements["stream-status"].textContent = "Stream paused · refreshing";
  scheduleEventRefresh(controller, generation);
}

async function openEventStream(after, controller, projectId, runId) {
  return await fetch(
    `/api/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`,
    {
      headers: { authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    },
  );
}

async function consumeEventStream(response, generation, projectId, runId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done || !isCurrentEventSelection(generation, projectId, runId)) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    appendStreamEvents(lines);
    renderEvents();
  }
}

function scheduleEventRefresh(controller, generation) {
  if (!controller.signal.aborted && generation === state.streamGeneration) {
    setTimeout(() => {
      if (generation === state.streamGeneration) loadRuns().catch(showError);
    }, 750);
  }
}

function appendStreamEvents(lines) {
  for (const line of lines.filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.seq && !state.events.some((item) => item.seq === event.seq)) {
      state.events.push(event);
    }
  }
}

export async function waitForNewRun(previousIds) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await api(`/projects/${encodeURIComponent(state.projectId)}/runs?limit=100`);
    const discovered = data.runs.find((run) => !previousIds.has(run.id));
    if (discovered) {
      state.runs = data.runs;
      state.runId = discovered.id;
      renderRuns();
      renderRun();
      await loadEvents();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await loadRuns();
}
